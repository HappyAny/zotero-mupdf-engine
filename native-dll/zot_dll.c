#include "zot_dll.h"
#include "../engine/mupdf_render.h"

#include <math.h>
#include <process.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

#define MAX_WORKER_DOCS 6
#define MAX_DLS 64
#define MAX_ACTIVE_COOKIES 64
#define BG_QUEUE_CAP 24
#define MAX_PIX_RECYCLE 4

/* Thread-local open document cache: each foreground ChromeWorker and each bg_worker
 * owns its own fz_document* handles -> ZERO cross-thread doc_lock, ZERO priority inversion,
 * and true multi-core parallel display-list building on the same PDF! */
typedef struct {
    char *path;
    char *password;
    int64_t mtime;
    int64_t fsize;
    fz_document *doc;
    int page_count;
    uint64_t last_used;
} WorkerDocSlot;

typedef struct {
    WorkerDocSlot slots[MAX_WORKER_DOCS];
    int count;
    uint64_t clock;
    LONG64 last_evict_gen;
} WorkerDocCache;

typedef struct {
    char *path;
    char *password;
    int64_t mtime;
    int64_t fsize;
    int page_index;
    int include_annots;
    int page_count;
    fz_display_list *dl;
    ZotRect bounds;
    int refs;
    uint64_t last_used;
    int in_cache;
} DLEntry;

typedef struct PixKey {
    char *path;
    int64_t mtime;
    int64_t fsize;
    char *password;
    int page_index;
    int width;
    int height;
    int32_t qm[6];
    int include_annots;
    int aa_level;
    ZotTheme theme;
} PixKey;

typedef struct PixEntry {
    PixKey key;
    unsigned char *rgba;
    size_t byte_len;
    float page_w;
    float page_h;
    int page_count;
    uint64_t last_used;
    struct PixEntry *prev;
    struct PixEntry *next;
} PixEntry;

typedef struct {
    unsigned char *ptr;
    size_t byte_len;
} PixRecycledBuf;

typedef struct {
    int req_id;
    fz_cookie *cookie;
} ActiveCookie;

typedef struct {
    char *path;
    char *password;
    int page_index;
    int width;
    int height;
    float src_pw;
    float src_ph;
    float m[6];
    int include_annots;
    int aa_level;
    ZotTheme theme;
} BgJob;

typedef struct {
    fz_context *base_ctx;
    void *base_locks;

    SRWLOCK cache_lock;
    uint64_t clock;
    DLEntry *dls[MAX_DLS];
    int dl_count;

    volatile LONG64 evict_gen;
    volatile LONG fg_active;

    SRWLOCK pix_lock;
    PixEntry *pix_head; // MRU
    PixEntry *pix_tail; // LRU
    size_t pix_bytes;
    size_t max_pix_bytes;
    PixRecycledBuf pix_recycle[MAX_PIX_RECYCLE];
    int pix_recycle_count;

    SRWLOCK cookie_lock;
    ActiveCookie cookies[MAX_ACTIVE_COOKIES];

    CRITICAL_SECTION bg_cs;
    CONDITION_VARIABLE bg_cv;
    BgJob bg_queue[BG_QUEUE_CAP]; // index 0..bg_count-1; index 0 is highest priority!
    int bg_count;
    int bg_stop;
    char *last_fg_path;
    int last_fg_page;
    int last_fg_dir; // +1 = scrolling down, -1 = scrolling up
    HANDLE *bg_threads;
    int bg_thread_count;
} ZotEngine;

typedef struct {
    fz_context *ctx;
    WorkerDocCache doc_cache;
} ZotWorker;

static SRWLOCK g_singleton_lock = SRWLOCK_INIT;
static ZotEngine *g_engine = NULL;
static int g_engine_refs = 0;

static double now_ms(void) {
    static LARGE_INTEGER freq = {0};
    if (freq.QuadPart == 0) {
        QueryPerformanceFrequency(&freq);
    }
    LARGE_INTEGER cnt;
    QueryPerformanceCounter(&cnt);
    return (double)cnt.QuadPart * 1000.0 / (double)freq.QuadPart;
}

static char *dup_str(const char *s) {
    if (!s) s = "";
    size_t n = strlen(s);
    char *out = (char *)malloc(n + 1);
    if (out) memcpy(out, s, n + 1);
    return out;
}

static int stat_utf8(const char *path_utf8, int64_t *out_mtime, int64_t *out_size) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path_utf8, -1, NULL, 0);
    if (wlen <= 0) return -1;
    wchar_t *wpath = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
    if (!wpath) return -1;
    MultiByteToWideChar(CP_UTF8, 0, path_utf8, -1, wpath, wlen);

    WIN32_FILE_ATTRIBUTE_DATA fad;
    BOOL ok = GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad);
    free(wpath);
    if (!ok) return -1;

    ULARGE_INTEGER sz, mt;
    sz.LowPart = fad.nFileSizeLow;
    sz.HighPart = fad.nFileSizeHigh;
    mt.LowPart = fad.ftLastWriteTime.dwLowDateTime;
    mt.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    *out_size = (int64_t)sz.QuadPart;
    *out_mtime = (int64_t)mt.QuadPart;
    return 0;
}

static void quantize_m(const float m[6], int32_t qm[6]) {
    for (int i = 0; i < 6; i++) {
        qm[i] = (int32_t)llround((double)m[i] * 1000.0);
    }
}

static int theme_eq(const ZotTheme *a, const ZotTheme *b) {
    if (a->enabled != b->enabled) return 0;
    if (!a->enabled) return 1;
    return a->invert_images == b->invert_images &&
           a->bg[0] == b->bg[0] && a->bg[1] == b->bg[1] && a->bg[2] == b->bg[2] &&
           a->fg[0] == b->fg[0] && a->fg[1] == b->fg[1] && a->fg[2] == b->fg[2];
}

static int pix_key_eq(const PixKey *a, const PixKey *b) {
    return a->page_index == b->page_index &&
           a->width == b->width &&
           a->height == b->height &&
           a->mtime == b->mtime &&
           a->fsize == b->fsize &&
           a->include_annots == b->include_annots &&
           a->aa_level == b->aa_level &&
           memcmp(a->qm, b->qm, sizeof(a->qm)) == 0 &&
           theme_eq(&a->theme, &b->theme) &&
           strcmp(a->path, b->path) == 0 &&
           strcmp(a->password, b->password) == 0;
}

/* ---------------- Thread-local WorkerDocCache ---------------- */

static void worker_doc_cache_clear(fz_context *wctx, WorkerDocCache *dc) {
    for (int i = 0; i < dc->count; i++) {
        if (dc->slots[i].doc) {
            zot_drop_document(wctx, dc->slots[i].doc);
            dc->slots[i].doc = NULL;
        }
        free(dc->slots[i].path);
        free(dc->slots[i].password);
        dc->slots[i].path = NULL;
        dc->slots[i].password = NULL;
    }
    dc->count = 0;
}

static fz_document *worker_doc_get(
    ZotEngine *eng,
    fz_context *wctx,
    WorkerDocCache *dc,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int *out_page_count,
    char *err_buf,
    int err_cap
) {
    LONG64 cur_gen = InterlockedCompareExchange64(&eng->evict_gen, 0, 0);
    if (dc->last_evict_gen != cur_gen) {
        worker_doc_cache_clear(wctx, dc);
        dc->last_evict_gen = cur_gen;
    }

    for (int i = 0; i < dc->count; i++) {
        WorkerDocSlot *s = &dc->slots[i];
        if (s->mtime == mtime && s->fsize == fsize &&
            strcmp(s->path, path) == 0 && strcmp(s->password, password) == 0) {
            s->last_used = ++dc->clock;
            if (out_page_count) *out_page_count = s->page_count;
            return s->doc;
        }
    }

    int page_count = 0;
    fz_document *doc = zot_open_document(wctx, path, password[0] ? password : NULL, &page_count, err_buf, err_cap);
    if (!doc) return NULL;

    int target = dc->count;
    if (dc->count >= MAX_WORKER_DOCS) {
        int victim = 0;
        for (int i = 1; i < dc->count; i++) {
            if (dc->slots[i].last_used < dc->slots[victim].last_used) {
                victim = i;
            }
        }
        if (dc->slots[victim].doc) {
            zot_drop_document(wctx, dc->slots[victim].doc);
        }
        free(dc->slots[victim].path);
        free(dc->slots[victim].password);
        target = victim;
    } else {
        dc->count++;
    }

    WorkerDocSlot *slot = &dc->slots[target];
    slot->path = dup_str(path);
    slot->password = dup_str(password);
    slot->mtime = mtime;
    slot->fsize = fsize;
    slot->doc = doc;
    slot->page_count = page_count;
    slot->last_used = ++dc->clock;

    if (out_page_count) *out_page_count = page_count;
    return doc;
}

/* ---------------- Rendered RGBA Bitmap LRU Cache + Warm Buffer Recycling ---------------- */

static unsigned char *pix_alloc_buf(ZotEngine *eng, size_t byte_len) {
    unsigned char *reused = NULL;
    AcquireSRWLockExclusive(&eng->pix_lock);
    for (int i = eng->pix_recycle_count - 1; i >= 0; i--) {
        if (eng->pix_recycle[i].byte_len == byte_len) {
            reused = eng->pix_recycle[i].ptr;
            eng->pix_recycle[i] = eng->pix_recycle[--eng->pix_recycle_count];
            break;
        }
    }
    ReleaseSRWLockExclusive(&eng->pix_lock);
    if (reused) return reused;
    return (unsigned char *)malloc(byte_len);
}

static void pix_recycle_buf_locked(ZotEngine *eng, unsigned char *ptr, size_t byte_len) {
    if (!ptr) return;
    if (byte_len >= (1u << 20) && eng->pix_recycle_count < MAX_PIX_RECYCLE) {
        eng->pix_recycle[eng->pix_recycle_count].ptr = ptr;
        eng->pix_recycle[eng->pix_recycle_count].byte_len = byte_len;
        eng->pix_recycle_count++;
        return;
    }
    free(ptr);
}

static void pix_release_buf(ZotEngine *eng, unsigned char *ptr, size_t byte_len) {
    if (!ptr) return;
    AcquireSRWLockExclusive(&eng->pix_lock);
    pix_recycle_buf_locked(eng, ptr, byte_len);
    ReleaseSRWLockExclusive(&eng->pix_lock);
}

static void free_pix_entry_meta(PixEntry *e) {
    if (!e) return;
    free(e->key.path);
    free(e->key.password);
    free(e);
}

static void free_pix_entry(PixEntry *e) {
    if (!e) return;
    free(e->rgba);
    free_pix_entry_meta(e);
}

static void pix_unlink(ZotEngine *eng, PixEntry *e) {
    if (e->prev) e->prev->next = e->next;
    else eng->pix_head = e->next;
    if (e->next) e->next->prev = e->prev;
    else eng->pix_tail = e->prev;
    e->prev = e->next = NULL;
}

static void pix_push_front(ZotEngine *eng, PixEntry *e) {
    e->prev = NULL;
    e->next = eng->pix_head;
    if (eng->pix_head) eng->pix_head->prev = e;
    else eng->pix_tail = e;
    eng->pix_head = e;
}

static int pix_exists(ZotEngine *eng, const PixKey *k) {
    AcquireSRWLockShared(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            ReleaseSRWLockShared(&eng->pix_lock);
            return 1;
        }
        cur = cur->next;
    }
    ReleaseSRWLockShared(&eng->pix_lock);
    return 0;
}

static int pix_lookup_copy(
    ZotEngine *eng,
    const PixKey *k,
    unsigned char *out_rgba,
    float *out_pw,
    float *out_ph,
    int *out_page_count
) {
    AcquireSRWLockExclusive(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            if (cur != eng->pix_head) {
                pix_unlink(eng, cur);
                pix_push_front(eng, cur);
            }
            if (out_rgba) {
                memcpy(out_rgba, cur->rgba, cur->byte_len);
            }
            if (out_pw) *out_pw = cur->page_w;
            if (out_ph) *out_ph = cur->page_h;
            if (out_page_count) *out_page_count = cur->page_count;
            ReleaseSRWLockExclusive(&eng->pix_lock);
            return 1;
        }
        cur = cur->next;
    }
    ReleaseSRWLockExclusive(&eng->pix_lock);
    return 0;
}

/* Takes ownership of `owned_rgba` (recycles evicted buffers to eliminate Windows VirtualAlloc page-fault storms!) */
static void pix_store_take(
    ZotEngine *eng,
    const PixKey *k,
    unsigned char *owned_rgba,
    size_t byte_len,
    float pw,
    float ph,
    int page_count
) {
    if (!owned_rgba || byte_len == 0 || byte_len > eng->max_pix_bytes / 2) {
        pix_release_buf(eng, owned_rgba, byte_len);
        return;
    }

    AcquireSRWLockExclusive(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            pix_recycle_buf_locked(eng, cur->rgba, cur->byte_len);
            eng->pix_bytes -= cur->byte_len;
            cur->rgba = owned_rgba;
            cur->byte_len = byte_len;
            cur->page_w = pw;
            cur->page_h = ph;
            cur->page_count = page_count;
            eng->pix_bytes += byte_len;
            if (cur != eng->pix_head) {
                pix_unlink(eng, cur);
                pix_push_front(eng, cur);
            }
            ReleaseSRWLockExclusive(&eng->pix_lock);
            return;
        }
        cur = cur->next;
    }

    PixEntry *e = (PixEntry *)calloc(1, sizeof(PixEntry));
    if (!e) {
        pix_recycle_buf_locked(eng, owned_rgba, byte_len);
        ReleaseSRWLockExclusive(&eng->pix_lock);
        return;
    }
    e->key = *k;
    e->key.path = dup_str(k->path);
    e->key.password = dup_str(k->password);
    e->rgba = owned_rgba;
    e->byte_len = byte_len;
    e->page_w = pw;
    e->page_h = ph;
    e->page_count = page_count;
    pix_push_front(eng, e);
    eng->pix_bytes += byte_len;

    while (eng->pix_bytes > eng->max_pix_bytes && eng->pix_tail && eng->pix_tail != eng->pix_head) {
        PixEntry *ev = eng->pix_tail;
        pix_unlink(eng, ev);
        eng->pix_bytes -= ev->byte_len;
        pix_recycle_buf_locked(eng, ev->rgba, ev->byte_len);
        ev->rgba = NULL;
        free_pix_entry_meta(ev);
    }
    ReleaseSRWLockExclusive(&eng->pix_lock);
}

static void pix_store_copy(
    ZotEngine *eng,
    const PixKey *k,
    const unsigned char *rgba,
    size_t byte_len,
    float pw,
    float ph,
    int page_count
) {
    if (!rgba || byte_len == 0 || byte_len > eng->max_pix_bytes / 2) return;
    unsigned char *copy = pix_alloc_buf(eng, byte_len);
    if (!copy) return;
    memcpy(copy, rgba, byte_len);
    pix_store_take(eng, k, copy, byte_len, pw, ph, page_count);
}

/* ---------------- Shared Display List LRU Cache (Self-Contained) ---------------- */

static void drop_dl_unlocked(fz_context *ctx, DLEntry *dl) {
    if (!dl) return;
    if (dl->dl) {
        zot_drop_display_list(ctx, dl->dl);
        dl->dl = NULL;
    }
    free(dl->path);
    free(dl->password);
    free(dl);
}

static DLEntry *acquire_dl(
    ZotEngine *eng,
    fz_context *wctx,
    WorkerDocCache *doc_cache,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int page_index,
    int include_annots,
    fz_cookie *cookie,
    int *out_dl_hit,
    int *out_page_count,
    int *out_aborted,
    char *err_buf,
    int err_cap
) {
    *out_dl_hit = 0;
    if (out_aborted) *out_aborted = 0;

    AcquireSRWLockExclusive(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        if (e->page_index == page_index && e->include_annots == include_annots &&
            e->mtime == mtime && e->fsize == fsize &&
            strcmp(e->path, path) == 0 && strcmp(e->password, password) == 0) {
            e->last_used = ++eng->clock;
            e->refs++;
            *out_dl_hit = 1;
            if (out_page_count) *out_page_count = e->page_count;
            ReleaseSRWLockExclusive(&eng->cache_lock);
            return e;
        }
    }
    ReleaseSRWLockExclusive(&eng->cache_lock);

    if (cookie && cookie->abort) {
        if (out_aborted) *out_aborted = 1;
        return NULL;
    }

    int page_count = 0;
    fz_document *doc = worker_doc_get(eng, wctx, doc_cache, path, password, mtime, fsize, &page_count, err_buf, err_cap);
    if (!doc) return NULL;
    if (out_page_count) *out_page_count = page_count;

    if (page_index < 0 || page_index >= page_count) {
        if (err_buf && err_cap > 0) {
            snprintf(err_buf, (size_t)err_cap, "page index %d out of range [0, %d)", page_index, page_count);
        }
        return NULL;
    }

    // Build display list completely LOCK-FREE using this worker's private fz_document* + abortable fz_cookie!
    ZotRect bounds = {0};
    int aborted = 0;
    fz_display_list *dl = zot_build_display_list_ex(
        wctx, doc, page_index, include_annots, cookie, &bounds, &aborted, err_buf, err_cap
    );
    if (!dl) {
        if (out_aborted) *out_aborted = aborted;
        return NULL;
    }

    DLEntry *ev_dl = NULL;

    AcquireSRWLockExclusive(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        if (e->page_index == page_index && e->include_annots == include_annots &&
            e->mtime == mtime && e->fsize == fsize &&
            strcmp(e->path, path) == 0 && strcmp(e->password, password) == 0) {
            e->last_used = ++eng->clock;
            e->refs++;
            *out_dl_hit = 1;
            ReleaseSRWLockExclusive(&eng->cache_lock);
            zot_drop_display_list(wctx, dl);
            return e;
        }
    }

    if (eng->dl_count >= MAX_DLS) {
        int victim = 0;
        for (int i = 1; i < eng->dl_count; i++) {
            if (eng->dls[i]->last_used < eng->dls[victim]->last_used) victim = i;
        }
        DLEntry *v = eng->dls[victim];
        v->in_cache = 0;
        v->refs--;
        if (v->refs <= 0) ev_dl = v;
        eng->dls[victim] = eng->dls[--eng->dl_count];
    }

    DLEntry *ne = (DLEntry *)calloc(1, sizeof(DLEntry));
    ne->path = dup_str(path);
    ne->password = dup_str(password);
    ne->mtime = mtime;
    ne->fsize = fsize;
    ne->page_index = page_index;
    ne->include_annots = include_annots;
    ne->page_count = page_count;
    ne->dl = dl;
    ne->bounds = bounds;
    ne->refs = 2; // 1 cache + 1 caller
    ne->last_used = ++eng->clock;
    ne->in_cache = 1;
    eng->dls[eng->dl_count++] = ne;
    ReleaseSRWLockExclusive(&eng->cache_lock);

    if (ev_dl) {
        drop_dl_unlocked(wctx, ev_dl);
    }
    return ne;
}

static void release_dl(ZotEngine *eng, fz_context *wctx, DLEntry *dl) {
    DLEntry *to_drop_dl = NULL;
    AcquireSRWLockExclusive(&eng->cache_lock);
    dl->refs--;
    if (dl->refs <= 0) to_drop_dl = dl;
    ReleaseSRWLockExclusive(&eng->cache_lock);
    if (to_drop_dl) {
        drop_dl_unlocked(wctx, to_drop_dl);
    }
}

/* ---------------- Active Request Cookie Table ---------------- */

static void register_cookie(ZotEngine *eng, int req_id, fz_cookie *c) {
    if (req_id <= 0) return;
    AcquireSRWLockExclusive(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].cookie == NULL) {
            eng->cookies[i].req_id = req_id;
            eng->cookies[i].cookie = c;
            break;
        }
    }
    ReleaseSRWLockExclusive(&eng->cookie_lock);
}

static void unregister_cookie(ZotEngine *eng, fz_cookie *c) {
    AcquireSRWLockExclusive(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].cookie == c) {
            eng->cookies[i].req_id = 0;
            eng->cookies[i].cookie = NULL;
            break;
        }
    }
    ReleaseSRWLockExclusive(&eng->cookie_lock);
}

/* ---------------- Direction-Aware LIFO Foreground-Yielding Pre-Renderer ---------------- */

static void free_bg_job(BgJob *j) {
    free(j->path);
    free(j->password);
    j->path = NULL;
    j->password = NULL;
}

static void schedule_bg_prerenders(
    ZotEngine *eng,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int page_index,
    int page_count,
    int width,
    int height,
    float src_pw,
    float src_ph,
    const float m[6],
    int include_annots,
    int aa_level,
    const ZotTheme *theme
) {
    if (eng->bg_thread_count <= 0) return;
    // Only pre-render real main viewer pages (never HiDPI 480x620 sidebar thumbnails!)
    if (width < 650 && height < 650) return;
    if (fabsf(m[4]) > 8.0f && fabsf(m[5]) > 8.0f) return;

    EnterCriticalSection(&eng->bg_cs);
    if (eng->bg_stop) {
        LeaveCriticalSection(&eng->bg_cs);
        return;
    }

    // Track scroll direction per document so upward scrolling pre-renders -1,-2,-3,+1!
    int dir = 1;
    if (eng->last_fg_path && strcmp(eng->last_fg_path, path) == 0) {
        if (page_index < eng->last_fg_page) dir = -1;
        else if (page_index > eng->last_fg_page) dir = 1;
        else dir = eng->last_fg_dir != 0 ? eng->last_fg_dir : 1;
    } else {
        free(eng->last_fg_path);
        eng->last_fg_path = dup_str(path);
    }
    eng->last_fg_page = page_index;
    eng->last_fg_dir = dir;

    // Flush stale jobs for the same PDF (old zoom dimensions or pages far from current viewport)
    int widx = 0;
    for (int i = 0; i < eng->bg_count; i++) {
        BgJob *ex = &eng->bg_queue[i];
        int stale = 0;
        if (strcmp(ex->path, path) == 0) {
            if (ex->width != width || ex->height != height || abs(ex->page_index - page_index) > 5) {
                stale = 1;
            }
        }
        if (stale) {
            free_bg_job(ex);
        } else {
            if (widx != i) eng->bg_queue[widx] = *ex;
            widx++;
        }
    }
    eng->bg_count = widx;

    // Insert in reverse priority order at front (index 0) so highest-priority neighbor (+dir) pops FIRST!
    const int offsets[4] = { dir * 3, -dir, dir * 2, dir };
    int woke = 0;
    for (int k = 0; k < 4; k++) {
        int tp = page_index + offsets[k];
        if (tp < 0 || (page_count > 0 && tp >= page_count)) continue;

        PixKey pk;
        memset(&pk, 0, sizeof(pk));
        pk.path = (char *)path;
        pk.password = (char *)password;
        pk.mtime = mtime;
        pk.fsize = fsize;
        pk.page_index = tp;
        pk.width = width;
        pk.height = height;
        quantize_m(m, pk.qm);
        pk.include_annots = include_annots;
        pk.aa_level = aa_level;
        pk.theme = *theme;

        if (pix_exists(eng, &pk)) continue;

        // Remove existing duplicate so it gets promoted to the front
        for (int q = 0; q < eng->bg_count; q++) {
            BgJob *ex = &eng->bg_queue[q];
            if (ex->page_index == tp && ex->width == width && ex->height == height && strcmp(ex->path, path) == 0) {
                free_bg_job(ex);
                if (q + 1 < eng->bg_count) {
                    memmove(&eng->bg_queue[q], &eng->bg_queue[q + 1], (size_t)(eng->bg_count - q - 1) * sizeof(BgJob));
                }
                eng->bg_count--;
                break;
            }
        }

        if (eng->bg_count >= BG_QUEUE_CAP) {
            free_bg_job(&eng->bg_queue[eng->bg_count - 1]);
            eng->bg_count--;
        }
        if (eng->bg_count > 0) {
            memmove(&eng->bg_queue[1], &eng->bg_queue[0], (size_t)eng->bg_count * sizeof(BgJob));
        }
        BgJob *slot = &eng->bg_queue[0];
        slot->path = dup_str(path);
        slot->password = dup_str(password);
        slot->page_index = tp;
        slot->width = width;
        slot->height = height;
        slot->src_pw = src_pw;
        slot->src_ph = src_ph;
        memcpy(slot->m, m, sizeof(slot->m));
        slot->include_annots = include_annots;
        slot->aa_level = aa_level;
        slot->theme = *theme;
        eng->bg_count++;
        woke = 1;
    }
    if (woke) {
        WakeAllConditionVariable(&eng->bg_cv);
    }
    LeaveCriticalSection(&eng->bg_cs);
}

static unsigned __stdcall bg_worker_proc(void *arg) {
    ZotEngine *eng = (ZotEngine *)arg;
    // Below-normal priority guarantees background pre-rendering NEVER starves Zotero's UI/compositor!
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);

    fz_context *wctx = zot_clone_context(eng->base_ctx);
    if (!wctx) return 0;

    WorkerDocCache local_docs;
    memset(&local_docs, 0, sizeof(local_docs));

    for (;;) {
        BgJob job;
        EnterCriticalSection(&eng->bg_cs);
        while (!eng->bg_stop && (eng->bg_count == 0 || InterlockedCompareExchange(&eng->fg_active, 0, 0) > 0)) {
            DWORD timeout = eng->bg_count == 0 ? INFINITE : 35;
            SleepConditionVariableCS(&eng->bg_cv, &eng->bg_cs, timeout);
        }
        if (eng->bg_stop) {
            LeaveCriticalSection(&eng->bg_cs);
            break;
        }
        // Pop highest-priority job from index 0
        job = eng->bg_queue[0];
        eng->bg_count--;
        if (eng->bg_count > 0) {
            memmove(&eng->bg_queue[0], &eng->bg_queue[1], (size_t)eng->bg_count * sizeof(BgJob));
        }
        LeaveCriticalSection(&eng->bg_cs);

        int64_t mtime = 0, fsize = 0;
        if (stat_utf8(job.path, &mtime, &fsize) == 0) {
            PixKey pk;
            memset(&pk, 0, sizeof(pk));
            pk.path = job.path;
            pk.password = job.password;
            pk.mtime = mtime;
            pk.fsize = fsize;
            pk.page_index = job.page_index;
            pk.width = job.width;
            pk.height = job.height;
            quantize_m(job.m, pk.qm);
            pk.include_annots = job.include_annots;
            pk.aa_level = job.aa_level;
            pk.theme = job.theme;

            if (!pix_exists(eng, &pk)) {
                int dl_hit = 0, page_count = 0, aborted = 0;
                char err_buf[256];
                DLEntry *dl = acquire_dl(
                    eng, wctx, &local_docs, job.path, job.password, mtime, fsize,
                    job.page_index, job.include_annots, NULL, &dl_hit, &page_count, &aborted,
                    err_buf, sizeof(err_buf)
                );
                if (dl) {
                    float pw = dl->bounds.x1 - dl->bounds.x0;
                    float ph = dl->bounds.y1 - dl->bounds.y0;
                    // Skip rasterizing at wrong aspect if this page has different physical page dimensions
                    // (the parsed Display List still stays cached in eng->dls for instant rendering!)
                    int same_dims = (job.src_pw <= 0.0f || job.src_ph <= 0.0f) ||
                                    (fabsf(pw - job.src_pw) <= 2.5f && fabsf(ph - job.src_ph) <= 2.5f);
                    if (InterlockedCompareExchange(&eng->fg_active, 0, 0) > 0) {
                        SwitchToThread();
                    }
                    if (same_dims && !eng->bg_stop && !pix_exists(eng, &pk)) {
                        size_t nbytes = (size_t)job.width * (size_t)job.height * 4;
                        unsigned char *buf = pix_alloc_buf(eng, nbytes);
                        if (buf) {
                            fz_cookie cookie;
                            memset(&cookie, 0, sizeof(cookie));
                            int rc = zot_render_display_list(
                                wctx, dl->dl, dl->bounds, job.m, job.width, job.height,
                                job.aa_level, &job.theme, &cookie, buf, err_buf, sizeof(err_buf)
                            );
                            if (rc == 0) {
                                pix_store_take(eng, &pk, buf, nbytes, pw, ph, page_count);
                            } else {
                                pix_release_buf(eng, buf, nbytes);
                            }
                        }
                    }
                    release_dl(eng, wctx, dl);
                }
            }
        }
        free_bg_job(&job);
    }

    worker_doc_cache_clear(wctx, &local_docs);
    zot_drop_cloned_context(wctx);
    return 0;
}

/* ---------------- Engine Lifecycle ---------------- */

static ZotEngine *create_engine_internal(int store_mb, int pix_cache_mb, int bg_workers) {
    if (store_mb <= 0) store_mb = 256;
    if (pix_cache_mb <= 0) pix_cache_mb = 512;
    if (bg_workers < 0) bg_workers = 0;
    if (bg_workers > 4) bg_workers = 4;

    ZotEngine *eng = (ZotEngine *)calloc(1, sizeof(ZotEngine));
    if (!eng) return NULL;

    eng->base_ctx = zot_new_base_context((size_t)store_mb << 20, &eng->base_locks);
    if (!eng->base_ctx) {
        free(eng);
        return NULL;
    }

    InitializeSRWLock(&eng->cache_lock);
    InitializeSRWLock(&eng->pix_lock);
    InitializeSRWLock(&eng->cookie_lock);
    InitializeCriticalSection(&eng->bg_cs);
    InitializeConditionVariable(&eng->bg_cv);
    eng->max_pix_bytes = (size_t)pix_cache_mb << 20;
    eng->last_fg_dir = 1;

    if (bg_workers > 0) {
        eng->bg_threads = (HANDLE *)calloc((size_t)bg_workers, sizeof(HANDLE));
        if (eng->bg_threads) {
            for (int i = 0; i < bg_workers; i++) {
                uintptr_t th = _beginthreadex(NULL, 0, bg_worker_proc, eng, 0, NULL);
                if (th != 0) {
                    eng->bg_threads[eng->bg_thread_count++] = (HANDLE)th;
                }
            }
        }
    }
    return eng;
}

static void destroy_engine_internal(ZotEngine *eng) {
    if (!eng) return;

    EnterCriticalSection(&eng->bg_cs);
    eng->bg_stop = 1;
    for (int i = 0; i < eng->bg_count; i++) {
        free_bg_job(&eng->bg_queue[i]);
    }
    eng->bg_count = 0;
    free(eng->last_fg_path);
    eng->last_fg_path = NULL;
    WakeAllConditionVariable(&eng->bg_cv);
    LeaveCriticalSection(&eng->bg_cs);

    for (int i = 0; i < eng->bg_thread_count; i++) {
        WaitForSingleObject(eng->bg_threads[i], 3000);
        CloseHandle(eng->bg_threads[i]);
    }
    free(eng->bg_threads);
    DeleteCriticalSection(&eng->bg_cs);

    PixEntry *pe = eng->pix_head;
    while (pe) {
        PixEntry *next = pe->next;
        free_pix_entry(pe);
        pe = next;
    }
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }

    for (int i = 0; i < eng->dl_count; i++) {
        drop_dl_unlocked(eng->base_ctx, eng->dls[i]);
    }

    zot_drop_base_context(eng->base_ctx, eng->base_locks);
    free(eng);
}

/* ---------------- Exported DLL API ---------------- */

ZOT_EXPORT const char *zot_dll_version(void) {
    return zot_mupdf_version();
}

ZOT_EXPORT void *zot_dll_engine_acquire(int store_mb, int pix_cache_mb, int bg_workers) {
    AcquireSRWLockExclusive(&g_singleton_lock);
    if (!g_engine) {
        g_engine = create_engine_internal(store_mb, pix_cache_mb, bg_workers);
    }
    if (g_engine) {
        g_engine_refs++;
    }
    void *ret = g_engine;
    ReleaseSRWLockExclusive(&g_singleton_lock);
    return ret;
}

ZOT_EXPORT void zot_dll_engine_release(void *eng) {
    ZotEngine *to_destroy = NULL;
    AcquireSRWLockExclusive(&g_singleton_lock);
    if (eng && eng == g_engine) {
        g_engine_refs--;
        if (g_engine_refs <= 0) {
            to_destroy = g_engine;
            g_engine = NULL;
            g_engine_refs = 0;
        }
    }
    ReleaseSRWLockExclusive(&g_singleton_lock);
    if (to_destroy) {
        destroy_engine_internal(to_destroy);
    }
}

ZOT_EXPORT void zot_dll_engine_evict(void *eng_ptr) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng) return;

    EnterCriticalSection(&eng->bg_cs);
    for (int i = 0; i < eng->bg_count; i++) {
        free_bg_job(&eng->bg_queue[i]);
    }
    eng->bg_count = 0;
    LeaveCriticalSection(&eng->bg_cs);

    AcquireSRWLockExclusive(&eng->pix_lock);
    PixEntry *pe = eng->pix_head;
    eng->pix_head = eng->pix_tail = NULL;
    eng->pix_bytes = 0;
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }
    eng->pix_recycle_count = 0;
    ReleaseSRWLockExclusive(&eng->pix_lock);
    while (pe) {
        PixEntry *next = pe->next;
        free_pix_entry(pe);
        pe = next;
    }

    InterlockedIncrement64(&eng->evict_gen);

    fz_context *tmp = zot_clone_context(eng->base_ctx);
    if (!tmp) return;

    DLEntry *drop_dls[MAX_DLS];
    int n_dls = 0;

    AcquireSRWLockExclusive(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        e->in_cache = 0;
        e->refs--;
        if (e->refs <= 0) drop_dls[n_dls++] = e;
    }
    eng->dl_count = 0;
    ReleaseSRWLockExclusive(&eng->cache_lock);

    for (int i = 0; i < n_dls; i++) {
        drop_dl_unlocked(tmp, drop_dls[i]);
    }
    zot_drop_cloned_context(tmp);
}

ZOT_EXPORT void zot_dll_engine_abort(void *eng_ptr, int req_id) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng || req_id <= 0) return;
    AcquireSRWLockShared(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].req_id == req_id && eng->cookies[i].cookie) {
            zot_cookie_abort(eng->cookies[i].cookie);
        }
    }
    ReleaseSRWLockShared(&eng->cookie_lock);
}

ZOT_EXPORT void *zot_dll_worker_create(void *eng_ptr) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng) return NULL;
    ZotWorker *w = (ZotWorker *)calloc(1, sizeof(ZotWorker));
    if (!w) return NULL;
    w->ctx = zot_clone_context(eng->base_ctx);
    if (!w->ctx) {
        free(w);
        return NULL;
    }
    return w;
}

ZOT_EXPORT void zot_dll_worker_destroy(void *worker_ptr) {
    ZotWorker *w = (ZotWorker *)worker_ptr;
    if (!w) return;
    worker_doc_cache_clear(w->ctx, &w->doc_cache);
    zot_drop_cloned_context(w->ctx);
    free(w);
}

ZOT_EXPORT int zot_dll_render_rgba(
    void *eng_ptr,
    void *worker_ptr,
    int req_id,
    const char *path_utf8,
    const char *password_utf8,
    int page_index,
    int width,
    int height,
    float m0, float m1, float m2, float m3, float m4, float m5,
    int include_annots,
    int aa_level,
    int theme_enabled,
    int bg_rgb,
    int fg_rgb,
    int invert_images,
    unsigned char *out_rgba,
    float *out_stats,
    char *err_buf,
    int err_cap
) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    ZotWorker *worker = (ZotWorker *)worker_ptr;
    if (!eng || !worker || !worker->ctx || !path_utf8 || !out_rgba || width <= 0 || height <= 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "invalid arguments");
        return -1;
    }
    if (!password_utf8) password_utf8 = "";
    if (aa_level <= 0) aa_level = 8;

    double t0 = now_ms();

    int64_t mtime = 0, fsize = 0;
    if (stat_utf8(path_utf8, &mtime, &fsize) != 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "stat failed for pdf path");
        return -1;
    }

    float m[6] = { m0, m1, m2, m3, m4, m5 };
    ZotTheme theme;
    memset(&theme, 0, sizeof(theme));
    if (theme_enabled) {
        theme.enabled = 1;
        theme.bg[0] = (unsigned char)((bg_rgb >> 16) & 0xFF);
        theme.bg[1] = (unsigned char)((bg_rgb >> 8) & 0xFF);
        theme.bg[2] = (unsigned char)(bg_rgb & 0xFF);
        theme.fg[0] = (unsigned char)((fg_rgb >> 16) & 0xFF);
        theme.fg[1] = (unsigned char)((fg_rgb >> 8) & 0xFF);
        theme.fg[2] = (unsigned char)(fg_rgb & 0xFF);
        theme.invert_images = invert_images ? 1 : 0;
    }

    PixKey pk;
    memset(&pk, 0, sizeof(pk));
    pk.path = (char *)path_utf8;
    pk.password = (char *)password_utf8;
    pk.mtime = mtime;
    pk.fsize = fsize;
    pk.page_index = page_index;
    pk.width = width;
    pk.height = height;
    quantize_m(m, pk.qm);
    pk.include_annots = include_annots ? 1 : 0;
    pk.aa_level = aa_level;
    pk.theme = theme;

    // 1. Ultra-fast RAM RGBA bitmap cache hit (~1-2 ms direct memcpy into warm JS ArrayBuffer!)
    float hit_pw = 0.0f, hit_ph = 0.0f;
    int hit_pc = 0;
    if (pix_lookup_copy(eng, &pk, out_rgba, &hit_pw, &hit_ph, &hit_pc)) {
        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = 2.0f; // tier = pix
            out_stats[2] = hit_pw;
            out_stats[3] = hit_ph;
        }
        schedule_bg_prerenders(eng, path_utf8, password_utf8, mtime, fsize, page_index, hit_pc, width, height, hit_pw, hit_ph, m, pk.include_annots, aa_level, &theme);
        return 0;
    }

    // 2. Lock-free parallel display-list acquire + direct zero-copy rasterization into out_rgba
    InterlockedIncrement(&eng->fg_active);

    fz_cookie cookie;
    memset(&cookie, 0, sizeof(cookie));
    register_cookie(eng, req_id, &cookie);

    int dl_hit = 0, page_count = 0, aborted = 0;
    DLEntry *dl = acquire_dl(
        eng, worker->ctx, &worker->doc_cache, path_utf8, password_utf8, mtime, fsize,
        page_index, pk.include_annots, &cookie, &dl_hit, &page_count, &aborted,
        err_buf, err_cap
    );
    if (!dl) {
        unregister_cookie(eng, &cookie);
        if (InterlockedDecrement(&eng->fg_active) == 0) {
            EnterCriticalSection(&eng->bg_cs);
            WakeAllConditionVariable(&eng->bg_cv);
            LeaveCriticalSection(&eng->bg_cs);
        }
        return aborted ? 1 : -1;
    }

    int rc = zot_render_display_list(
        worker->ctx,
        dl->dl,
        dl->bounds,
        m,
        width,
        height,
        aa_level,
        &theme,
        &cookie,
        out_rgba,
        err_buf,
        err_cap
    );

    unregister_cookie(eng, &cookie);

    float pw = dl->bounds.x1 - dl->bounds.x0;
    float ph = dl->bounds.y1 - dl->bounds.y0;
    release_dl(eng, worker->ctx, dl);

    if (InterlockedDecrement(&eng->fg_active) == 0) {
        EnterCriticalSection(&eng->bg_cs);
        WakeAllConditionVariable(&eng->bg_cv);
        LeaveCriticalSection(&eng->bg_cs);
    }

    if (rc == 0) {
        size_t nbytes = (size_t)width * (size_t)height * 4;
        if (width >= 650 || height >= 650) {
            pix_store_copy(eng, &pk, out_rgba, nbytes, pw, ph, page_count);
            schedule_bg_prerenders(eng, path_utf8, password_utf8, mtime, fsize, page_index, page_count, width, height, pw, ph, m, pk.include_annots, aa_level, &theme);
        }

        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = dl_hit ? 1.0f : 0.0f;
            out_stats[2] = pw;
            out_stats[3] = ph;
        }
    }
    return rc;
}

ZOT_EXPORT int zot_dll_render_thumb_rgba(
    void *eng_ptr,
    void *worker_ptr,
    int req_id,
    const char *path_utf8,
    const char *password_utf8,
    int page_index,
    int target_w,
    int max_h,
    int aa_level,
    int theme_enabled,
    int bg_rgb,
    int fg_rgb,
    int invert_images,
    unsigned char *out_rgba,
    float *out_stats,
    char *err_buf,
    int err_cap
) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    ZotWorker *worker = (ZotWorker *)worker_ptr;
    if (!eng || !worker || !worker->ctx || !path_utf8 || !out_rgba || target_w <= 0 || max_h <= 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "invalid thumbnail arguments");
        return -1;
    }
    if (!password_utf8) password_utf8 = "";
    if (aa_level <= 0) aa_level = 4;

    double t0 = now_ms();

    int64_t mtime = 0, fsize = 0;
    if (stat_utf8(path_utf8, &mtime, &fsize) != 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "stat failed for pdf path");
        return -1;
    }

    ZotTheme theme;
    memset(&theme, 0, sizeof(theme));
    if (theme_enabled) {
        theme.enabled = 1;
        theme.bg[0] = (unsigned char)((bg_rgb >> 16) & 0xFF);
        theme.bg[1] = (unsigned char)((bg_rgb >> 8) & 0xFF);
        theme.bg[2] = (unsigned char)(bg_rgb & 0xFF);
        theme.fg[0] = (unsigned char)((fg_rgb >> 16) & 0xFF);
        theme.fg[1] = (unsigned char)((fg_rgb >> 8) & 0xFF);
        theme.fg[2] = (unsigned char)(fg_rgb & 0xFF);
        theme.invert_images = invert_images ? 1 : 0;
    }

    fz_cookie cookie;
    memset(&cookie, 0, sizeof(cookie));
    register_cookie(eng, req_id, &cookie);

    int dl_hit = 0, page_count = 0, aborted = 0;
    DLEntry *dl = acquire_dl(
        eng, worker->ctx, &worker->doc_cache, path_utf8, password_utf8, mtime, fsize,
        page_index, 1, &cookie, &dl_hit, &page_count, &aborted, err_buf, err_cap
    );
    if (!dl) {
        unregister_cookie(eng, &cookie);
        return aborted ? 1 : -1;
    }

    float pw = dl->bounds.x1 - dl->bounds.x0;
    float ph = dl->bounds.y1 - dl->bounds.y0;
    if (pw <= 0.1f || ph <= 0.1f) {
        release_dl(eng, worker->ctx, dl);
        unregister_cookie(eng, &cookie);
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "degenerate page bounds");
        return -1;
    }

    float scale = (float)target_w / pw;
    int w = target_w;
    int h = (int)lroundf(ph * scale);
    if (h < 1) h = 1;
    if (h > max_h) {
        h = max_h;
        scale = (float)max_h / ph;
        w = (int)lroundf(pw * scale);
        if (w < 1) w = 1;
        if (w > target_w) w = target_w;
    }

    float m[6] = { scale, 0.0f, 0.0f, scale, 0.0f, 0.0f };
    int rc = zot_render_display_list(
        worker->ctx,
        dl->dl,
        dl->bounds,
        m,
        w,
        h,
        aa_level,
        &theme,
        &cookie,
        out_rgba,
        err_buf,
        err_cap
    );

    unregister_cookie(eng, &cookie);
    release_dl(eng, worker->ctx, dl);

    if (rc == 0) {
        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = (float)w;
            out_stats[2] = (float)h;
            out_stats[3] = pw / ph;
        }
    }
    return rc;
}
