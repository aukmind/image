// Worker pool. Highest priority first, newest first within a priority (the thumbnails in view were asked for last).
// `large` tasks (full-size decodes) run one at a time across the pool: Android kills tabs that use too much memory.
// Tasks with an `affinity` key go to the worker that last ran that key when it's free (it keeps that image decoded).
export class WorkerPool {
    constructor(url, size) {
        this.url = url;
        this.size = Math.max(1, size);
        this.workers = [];
        this.queue = [];
        this.seq = 0;
        this.largeRunning = false;
    }

    run(type, payload, { priority = 0, large = false, tag = null, affinity = null, onProgress = null } = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({ type, payload, priority, large, tag, affinity, onProgress, resolve, reject, seq: this.seq++ });
            this.pump();
        });
    }

    // Drops queued (not yet running) tasks with this tag.
    cancel(tag) {
        if (!this.queue.some(t => t.tag === tag)) return;
        this.queue = this.queue.filter((t) => {
            if (t.tag !== tag) return true;
            t.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
            return false;
        });
    }

    idleWorker() {
        let w = this.workers.find(w => !w.busy);
        if (!w && this.workers.length < this.size) {
            w = { worker: new Worker(this.url, { type: 'module' }), busy: null, affinity: null };
            w.worker.onmessage = (e) => this.onMessage(w, e.data);
            w.worker.onerror = (e) => this.onCrash(w, e);
            this.workers.push(w);
        }
        return w;
    }

    next() {
        let best = -1;
        for (let i = 0; i < this.queue.length; i++) {
            const t = this.queue[i];
            if (t.large && this.largeRunning) continue;
            const b = this.queue[best];
            if (best === -1 || t.priority > b.priority || (t.priority === b.priority && t.seq > b.seq)) best = i;
        }
        return best === -1 ? null : this.queue.splice(best, 1)[0];
    }

    pump() {
        while (this.queue.length) {
            let w = this.idleWorker();
            if (!w) return;
            const task = this.next();
            if (!task) return;
            if (task.affinity) {
                const home = this.workers.find(x => x.affinity === task.affinity);
                if (home && !home.busy) w = home;
                else if (home) home.affinity = null; // the image moves to the worker that decodes it now
                w.affinity = task.affinity;
            }
            w.busy = task;
            if (task.large) this.largeRunning = true;
            try {
                w.worker.postMessage({ type: task.type, payload: task.payload });
            } catch (err) {
                // Uncloneable payload: fail this task without holding the worker (or the large slot) forever.
                if (task.large) this.largeRunning = false;
                w.busy = null;
                task.reject(err);
            }
        }
    }

    finish(w) {
        if (w.busy?.large) this.largeRunning = false;
        w.busy = null;
        this.pump();
    }

    onMessage(w, msg) {
        const task = w.busy;
        if (!task) return;
        if (msg.progress) {
            task.onProgress?.(msg.progress);
            return;
        }
        this.finish(w);
        if (msg.error) task.reject(Object.assign(new Error(msg.error), { code: msg.code }));
        else task.resolve(msg.result);
    }

    // A worker that died (out of memory, usually) is replaced; its task fails.
    onCrash(w, event) {
        event.preventDefault?.();
        const task = w.busy;
        w.worker.terminate();
        this.workers = this.workers.filter(x => x !== w);
        if (task?.large) this.largeRunning = false;
        task?.reject(new Error(event.message || 'The image worker stopped (out of memory?)'));
        this.pump();
    }
}
