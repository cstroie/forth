/*
 * JSForth core: a small, mostly standard Forth.
 *
 * Colon definitions are compiled into cell arrays and run by an inner
 * interpreter with an explicit call stack, so execution can be time-sliced
 * (runSlice) and interrupted. DOM-free; the UI supplies an output sink and
 * a storage adapter.
 */
(function (root) {
    'use strict';

    class ForthError extends Error {}
    function fail(msg) { throw new ForthError(msg); }

    const MAX_STACK = 10000;
    const MAX_CALLS = 10000;
    const STORAGE_PREFIX = 'jsforth_program_';

    class Forth {
        /**
         * @param {(text: string, kind?: string) => void} out
         * @param {{get(k):string|null, set(k,v):boolean, remove(k):void, keys():string[]}} storage
         */
        constructor(out, storage) {
            this.out = out;
            this.storage = storage;
            this.onDefine = null;
            this.cold();
        }

        /** Reset everything: dictionary, memory, stacks. */
        cold() {
            this.stack = [];
            this.fstack = [];
            this.rstack = [];
            this.frames = [];
            this.keys = [];           // keystrokes waiting for KEY
            this.mem = [];
            this.here = 0;
            this.base = 10;
            this.dict = new Map();
            this.xts = [];
            this.latest = null;
            this.compiling = null;    // word being compiled
            this.paused = false;      // inside [ ... ] while compiling
            this.cs = [];             // compile-time control stack
            this.version = 0;         // bumped whenever the dictionary changes
            this.pic = '';            // pictured numeric output buffer
            this.queue = [];          // pending input lines
            this.src = '';
            this.pos = 0;
            this.line = null;
            this.state = 'idle';
            this.defLines = [];       // input lines that defined words (for SAVE/autosave)
            this.column = 0;
            this.definePrimitives();
        }

        // ---- output -----------------------------------------------------------

        emit(text, kind) {
            text = String(text);
            if (!text) return;
            this.out(text, kind);
            const nl = text.lastIndexOf('\n');
            this.column = nl >= 0 ? text.length - nl - 1 : this.column + text.length;
        }

        newline() { this.emit('\n'); }

        // ---- stacks -----------------------------------------------------------

        push(v) {
            if (this.stack.length >= MAX_STACK) fail('stack overflow');
            this.stack.push(v);
        }

        pop() {
            if (!this.stack.length) fail('stack underflow');
            return this.stack.pop();
        }

        peek(n = 0) {
            if (this.stack.length <= n) fail('stack underflow');
            return this.stack[this.stack.length - 1 - n];
        }

        need(n) { if (this.stack.length < n) fail('stack underflow'); }

        fpush(v) {
            if (this.fstack.length >= MAX_STACK) fail('float stack overflow');
            this.fstack.push(v);
        }

        fpop() {
            if (!this.fstack.length) fail('float stack underflow');
            return this.fstack.pop();
        }

        /** Double-cell number from the stack (lo hi), as a JS number. */
        popD() {
            const hi = this.pop(), lo = this.pop();
            return hi * 4294967296 + (lo >>> 0);
        }

        pushD(v) {
            const hi = Math.floor(v / 4294967296);
            this.push((v - hi * 4294967296) | 0);
            this.push(hi | 0);
        }

        rpop() {
            if (!this.rstack.length) fail('return stack underflow');
            return this.rstack.pop();
        }

        // ---- memory -----------------------------------------------------------

        fetch(addr) {
            if (!Number.isInteger(addr) || addr < 0 || addr >= this.here) fail('invalid memory address');
            return this.mem[addr] ?? 0;
        }

        store(addr, v) {
            if (!Number.isInteger(addr) || addr < 0 || addr >= this.here) fail('invalid memory address');
            this.mem[addr] = v;
        }

        allot(n) {
            if (n < 0 || this.here + n > 1e6) fail('invalid allot');
            for (let i = 0; i < n; i++) this.mem[this.here + i] = 0;
            const addr = this.here;
            this.here += n;
            return addr;
        }

        comma(v) { this.mem[this.allot(1)] = v; }

        storeString(s) {
            const addr = this.allot(s.length);
            for (let i = 0; i < s.length; i++) this.mem[addr + i] = s.charCodeAt(i);
            return addr;
        }

        readString(addr, len) {
            let s = '';
            for (let i = 0; i < len; i++) s += String.fromCharCode(this.fetch(addr + i));
            return s;
        }

        // ---- dictionary -------------------------------------------------------

        define(name, props) {
            const w = { name: name.toLowerCase(), xt: this.xts.length, ...props };
            this.xts.push(w);
            this.dict.set(w.name, w);
            this.latest = w;
            this.version++;
            return w;
        }

        prim(names, fn, flags = {}) {
            for (const n of names.split(' ')) this.define(n, { prim: fn, builtin: true, ...flags });
        }

        find(name) { return this.dict.get(name.toLowerCase()); }

        // ---- input parsing ----------------------------------------------------

        /** Next whitespace-delimited word from the input, or null. */
        word() {
            const s = this.src;
            while (this.pos < s.length && /\s/.test(s[this.pos])) this.pos++;
            if (this.pos >= s.length) return null;
            const start = this.pos;
            while (this.pos < s.length && !/\s/.test(s[this.pos])) this.pos++;
            this.tokStart = start;
            this.tokEnd = this.pos;
            return s.slice(start, this.pos);
        }

        /** Raw text up to (and consuming) the delimiter. */
        parseUntil(ch) {
            const s = this.src;
            if (s[this.pos] === ' ') this.pos++;
            let end = s.indexOf(ch, this.pos);
            if (end < 0) end = s.length;
            const text = s.slice(this.pos, end);
            this.pos = end + 1;
            return text;
        }

        nameArg() {
            const n = this.word();
            if (n === null) fail('name expected');
            return n;
        }

        /** Floats need a decimal point or exponent and only parse in base 10. */
        parseFloatLiteral(tok) {
            if (this.base !== 10 || !/^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d*)$/.test(tok)) return null;
            const v = parseFloat(tok.replace(/[eE]$/, '').replace(/[eE]([-+])?$/, ''));
            return isNaN(v) ? null : v;
        }

        fmtFloat(v) {
            if (!isFinite(v)) return String(v);
            if (Number.isInteger(v) && Math.abs(v) < 1e15) return v + '.';
            return String(parseFloat(v.toPrecision(15)));
        }

        parseNumber(tok) {
            let base = this.base;
            let s = tok;
            if (/^'.'$/.test(s)) return s.charCodeAt(1);
            const prefix = { '$': 16, '#': 10, '%': 2 }[s[0]];
            if (prefix) { base = prefix; s = s.slice(1); }
            let neg = false;
            if (s[0] === '-') { neg = true; s = s.slice(1); }
            if (!s) return null;
            const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
            let v = 0;
            for (const c of s.toLowerCase()) {
                const d = digits.indexOf(c);
                if (d < 0) return null;
                v = v * base + d;
            }
            return (neg ? -v : v) | 0;
        }

        fmt(n) {
            return (n | 0).toString(this.base).toUpperCase();
        }

        // ---- driver -----------------------------------------------------------

        /** Queue a line typed by the user. */
        enter(text) {
            this.queue.push({ text, interactive: true });
            if (this.state === 'idle') this.state = 'running';
        }

        /** Queue lines silently (LOAD, autosave restore, examples). */
        evaluate(lines) {
            for (const text of lines) this.queue.push({ text, interactive: false });
            if (this.state === 'idle') this.state = 'running';
        }

        nextLine() {
            this.line = this.queue.shift();
            this.src = this.line.text;
            this.pos = 0;
            this.lineVersion = this.version;
            this.lineCompiling = !!this.compiling;
        }

        endLine() {
            const line = this.line;
            this.line = null;
            if (this.compiling) {
                // Definition continues on the next line
                this.compiling.text += this.src.slice(this.compiling.start).trim() + '\n';
                this.compiling.start = 0;
            }
            // Remember lines that added words so SAVE / autosave can replay them
            if (this.version !== this.lineVersion || this.lineCompiling || this.compiling) {
                this.defLines.push(line.text);
                if (!this.compiling && this.onDefine) this.onDefine();
            }
            if (line.interactive) {
                if (this.column > 0) this.emit(' ');
                this.emit(this.compiling ? 'compiled' : 'ok', 'ok');
                this.newline();
            }
        }

        /** Run for up to `ms` milliseconds. Returns 'running' or 'idle'. */
        runSlice(ms = 15) {
            if (this.state === 'sleep') {
                if (Date.now() < this.wakeAt) return 'sleep';
                this.state = 'running';
            }
            const t0 = Date.now();
            let count = 0;
            try {
                while (this.state === 'running') {
                    if (this.frames.length) {
                        this.step();
                        if ((++count & 1023) === 0 && Date.now() - t0 > ms) break;
                        continue;
                    }
                    if (!this.line) {
                        if (!this.queue.length) { this.state = 'idle'; break; }
                        this.nextLine();
                    }
                    const w = this.word();
                    if (w === null) this.endLine();
                    else this.interpret(w);
                }
            } catch (e) {
                if (!(e instanceof ForthError)) {
                    console.error(e);
                    e = new ForthError('internal error: ' + e.message);
                }
                this.abort(e.message);
            }
            return this.state;
        }

        /** Error recovery: report, then reset stacks and pending input. */
        abort(msg) {
            const inner = this.frames.length ? this.frames[this.frames.length - 1].w.name : null;
            if (this.column > 0) this.newline();
            this.emit(`Error: ${msg}${inner ? ' in ' + inner : ''}`, 'err');
            this.newline();
            // Point at the word on the input line that failed, gforth style
            if (this.line && this.tokEnd > this.tokStart) {
                const s = this.src;
                const before = s.slice(Math.max(0, this.tokStart - 30), this.tokStart);
                const after = s.slice(this.tokEnd, this.tokEnd + 30);
                this.emit(`  ${before}>>>${s.slice(this.tokStart, this.tokEnd)}<<<${after}`.trimEnd(), 'err');
                this.newline();
            }
            this.reset();
        }

        reset() {
            this.stack = [];
            this.fstack = [];
            this.rstack = [];
            this.frames = [];
            this.compiling = null;
            this.paused = false;
            this.pending = null;
            this.cs = [];
            this.queue = [];
            this.line = null;
            this.state = 'idle';
        }

        /** Break a running program (Esc). */
        interrupt() {
            if (this.state === 'idle') return;
            if (this.column > 0) this.newline();
            this.emit('Interrupted', 'err');
            this.newline();
            this.reset();
        }

        interpret(tok) {
            this.lastWord = tok;
            const compileMode = this.compiling && !this.paused;
            const w = this.find(tok);
            if (w) {
                if (compileMode && !w.immediate) this.compiling.code.push({ op: 'call', w });
                else {
                    if (w.compileOnly && !this.compiling) fail('compile-only word');
                    this.execute(w);
                }
                return;
            }
            const n = this.parseNumber(tok);
            if (n !== null) {
                if (compileMode) this.compiling.code.push({ op: 'lit', v: n });
                else this.push(n);
                return;
            }
            const f = this.parseFloatLiteral(tok);
            if (f === null) fail('undefined word');
            if (compileMode) this.compiling.code.push({ op: 'flit', v: f });
            else this.fpush(f);
        }

        /** Deliver a keystroke (character code) for KEY / KEY?. */
        provideKey(code) {
            if (this.state === 'key') {
                this.push(code);
                this.state = 'running';
            } else {
                this.keys.push(code);
            }
        }

        /** Deliver a typed line for ACCEPT. */
        provideLine(text) {
            if (this.state !== 'accept') return;
            const { addr, max } = this.pending;
            const s = text.slice(0, max);
            for (let i = 0; i < s.length; i++) this.store(addr + i, s.charCodeAt(i));
            this.pending = null;
            this.push(s.length);
            this.state = 'running';
        }

        execute(w) {
            if (w.prim) { w.prim.call(this); return; }
            if (w.data !== undefined) this.push(w.data);
            const code = w.code || w.doesCode;
            if (!code) return;
            if (this.frames.length >= MAX_CALLS) fail('return stack overflow');
            this.frames.push({ code, ip: w.code ? 0 : w.doesIp, w });
        }

        /** Execute one compiled cell. */
        step() {
            const f = this.frames[this.frames.length - 1];
            const c = f.code[f.ip++];
            if (!c) { this.frames.pop(); return; }
            this.lastWord = f.w.name;
            switch (c.op) {
                case 'call': this.execute(c.w); break;
                case 'lit': this.push(c.v); break;
                case 'branch': f.ip = c.to; break;
                case '0branch': if (this.pop() === 0) f.ip = c.to; break;
                case 'do': {
                    const index = this.pop(), limit = this.pop();
                    this.rstack.push(limit, index);
                    break;
                }
                case '?do': {
                    const index = this.pop(), limit = this.pop();
                    if (index === limit) f.ip = c.end;
                    else this.rstack.push(limit, index);
                    break;
                }
                case 'loop':
                case '+loop': {
                    const n = this.rstack.length;
                    if (n < 2) fail('loop without do');
                    const inc = c.op === 'loop' ? 1 : this.pop();
                    const limit = this.rstack[n - 2];
                    const old = this.rstack[n - 1];
                    const idx = old + inc;
                    // Standard termination: the index crossed the limit-1/limit boundary
                    const done = inc >= 0 ? old < limit && idx >= limit : old >= limit && idx < limit;
                    if (done) this.rstack.length = n - 2;
                    else { this.rstack[n - 1] = idx; f.ip = c.to; }
                    break;
                }
                case 'leave':
                    this.rstack.length -= 2;
                    f.ip = c.to;
                    break;
                case 'str': this.emit(c.s); break;
                case 'flit': this.fpush(c.v); break;
                case 'compile': this.code().push({ op: 'call', w: c.w }); break;
                case 'of': {
                    const v = this.pop();
                    if (this.peek() === v) this.pop(); else f.ip = c.to;
                    break;
                }
                case 'exit': this.frames.pop(); break;
                case 'does':
                    if (!this.latest || this.latest.data === undefined) fail('DOES> needs CREATE');
                    this.latest.doesCode = f.code;
                    this.latest.doesIp = f.ip;
                    this.frames.pop();
                    break;
                default: fail('bad cell ' + c.op);
            }
        }

        // ---- compiler helpers -------------------------------------------------

        code() {
            if (!this.compiling) fail('compile-only word');
            return this.compiling.code;
        }

        csPop(...types) {
            const e = this.cs.pop();
            if (!e || !types.includes(e.type)) fail('unbalanced control structure');
            return e;
        }

        // ---- primitives -------------------------------------------------------

        definePrimitives() {
            const P = (n, fn, fl) => this.prim(n, fn, fl);
            const I = (n, fn) => this.prim(n, fn, { immediate: true, compileOnly: true });
            const bin = fn => function () { const b = this.pop(), a = this.pop(); this.push(fn(a, b)); };
            const flag = b => (b ? -1 : 0);

            // stack
            P('dup', function () { this.push(this.peek()); });
            P('drop', function () { this.pop(); });
            P('swap', function () { const b = this.pop(), a = this.pop(); this.push(b); this.push(a); });
            P('over', function () { this.push(this.peek(1)); });
            P('rot', function () { this.need(3); const c = this.pop(), b = this.pop(), a = this.pop(); this.push(b); this.push(c); this.push(a); });
            P('-rot', function () { this.need(3); const c = this.pop(), b = this.pop(), a = this.pop(); this.push(c); this.push(a); this.push(b); });
            P('nip', function () { const b = this.pop(); this.pop(); this.push(b); });
            P('tuck', function () { const b = this.pop(), a = this.pop(); this.push(b); this.push(a); this.push(b); });
            P('pick', function () { const n = this.pop(); if (n < 0) fail('invalid index'); this.push(this.peek(n)); });
            P('roll', function () {
                const n = this.pop();
                if (n < 0) fail('invalid index');
                this.need(n + 1);
                this.push(this.stack.splice(this.stack.length - 1 - n, 1)[0]);
            });
            P('?dup', function () { const a = this.peek(); if (a !== 0) this.push(a); });
            P('2dup', function () { this.need(2); this.push(this.peek(1)); this.push(this.peek(1)); });
            P('2drop', function () { this.need(2); this.pop(); this.pop(); });
            P('2swap', function () { this.need(4); const d = this.pop(), c = this.pop(), b = this.pop(), a = this.pop(); this.push(c); this.push(d); this.push(a); this.push(b); });
            P('2over', function () { this.need(4); this.push(this.peek(3)); this.push(this.peek(3)); });
            P('depth', function () { this.push(this.stack.length); });
            P('clear', function () { this.stack = []; });
            P('>r', function () { this.rstack.push(this.pop()); }, { compileOnly: true });
            P('r>', function () { this.push(this.rpop()); }, { compileOnly: true });
            P('r@', function () { if (!this.rstack.length) fail('return stack underflow'); this.push(this.rstack[this.rstack.length - 1]); }, { compileOnly: true });

            // arithmetic (32-bit integers)
            P('+', bin((a, b) => (a + b) | 0));
            P('-', bin((a, b) => (a - b) | 0));
            P('*', bin((a, b) => Math.imul(a, b)));
            const div = (a, b) => { if (b === 0) fail('division by zero'); return Math.floor(a / b) | 0; };
            const mod = (a, b) => { if (b === 0) fail('division by zero'); return a - b * Math.floor(a / b); };
            P('/', bin(div));
            P('mod', bin(mod));
            P('/mod', function () { const b = this.pop(), a = this.pop(); this.push(mod(a, b)); this.push(div(a, b)); });
            P('*/', function () { const c = this.pop(), b = this.pop(), a = this.pop(); this.push(div(a * b, c)); });
            P('negate', function () { this.push(-this.pop() | 0); });
            P('abs', function () { this.push(Math.abs(this.pop()) | 0); });
            P('min', bin(Math.min));
            P('max', bin(Math.max));
            P('1+', function () { this.push((this.pop() + 1) | 0); });
            P('1-', function () { this.push((this.pop() - 1) | 0); });
            P('2*', function () { this.push(this.pop() << 1); });
            P('2/', function () { this.push(this.pop() >> 1); });
            P('lshift', bin((a, b) => a << b));
            P('rshift', bin((a, b) => (a >>> b) | 0));
            P('and', bin((a, b) => a & b));
            P('or', bin((a, b) => a | b));
            P('xor', bin((a, b) => a ^ b));
            P('invert', function () { this.push(~this.pop()); });
            P('random', function () { const n = this.pop(); if (n <= 0) fail('invalid range'); this.push(Math.floor(Math.random() * n)); });

            // comparison
            P('=', bin((a, b) => flag(a === b)));
            P('<>', bin((a, b) => flag(a !== b)));
            P('<', bin((a, b) => flag(a < b)));
            P('>', bin((a, b) => flag(a > b)));
            P('<=', bin((a, b) => flag(a <= b)));
            P('>=', bin((a, b) => flag(a >= b)));
            P('u<', bin((a, b) => flag((a >>> 0) < (b >>> 0))));
            P('0=', function () { this.push(flag(this.pop() === 0)); });
            P('0<>', function () { this.push(flag(this.pop() !== 0)); });
            P('0<', function () { this.push(flag(this.pop() < 0)); });
            P('0>', function () { this.push(flag(this.pop() > 0)); });
            P('within', function () { const hi = this.pop(), lo = this.pop(), n = this.pop(); this.push(flag(n >= lo && n < hi)); });
            P('true', function () { this.push(-1); });
            P('false', function () { this.push(0); });

            // output
            P('.', function () { this.emit(this.fmt(this.pop()) + ' '); });
            P('u.', function () { this.emit((this.pop() >>> 0).toString(this.base).toUpperCase() + ' '); });
            P('.r', function () { const w = this.pop(); this.emit(this.fmt(this.pop()).padStart(w)); });
            P('?', function () { this.emit(this.fmt(this.fetch(this.pop())) + ' '); });
            P('.s', function () { this.emit(`<${this.stack.length}> ` + this.stack.map(v => this.fmt(v) + ' ').join('')); });
            P('emit', function () { this.emit(String.fromCharCode(this.pop())); });
            P('cr', function () { this.newline(); });
            P('space', function () { this.emit(' '); });
            P('spaces', function () { this.emit(' '.repeat(Math.max(0, this.pop()))); });
            P('type', function () { const len = this.pop(), addr = this.pop(); this.emit(this.readString(addr, len)); });
            P('page cls', function () { this.out('', 'cls'); this.column = 0; });
            P('decimal', function () { this.base = 10; });
            P('hex', function () { this.base = 16; });
            P('binary', function () { this.base = 2; });

            // memory
            P('@', function () { this.push(this.fetch(this.pop())); });
            P('!', function () { const a = this.pop(); this.store(a, this.pop()); });
            P('+!', function () { const a = this.pop(); this.store(a, (this.fetch(a) + this.pop()) | 0); });
            P('c@', function () { this.push(this.fetch(this.pop()) & 255); });
            P('c!', function () { const a = this.pop(); this.store(a, this.pop() & 255); });
            P(',', function () { this.comma(this.pop()); });
            P('c,', function () { this.comma(this.pop() & 255); });
            P('here', function () { this.push(this.here); });
            P('allot', function () { this.allot(this.pop()); });
            P('cells chars', function () { /* one address unit per cell */ });
            P('cell+ char+', function () { this.push(this.pop() + 1); });

            // defining words
            P(':', function () {
                if (this.compiling) fail('nested definition');
                const name = this.nameArg();
                this.compiling = { name: name.toLowerCase(), code: [], text: '', start: this.pos - name.length };
            });
            this.prim(';', function () {
                if (this.cs.length) fail('unbalanced control structure');
                const c = this.compiling;
                const w = this.define(c.name, { code: c.code });
                w.source = ': ' + (c.text + this.src.slice(c.start, this.pos)).trim();
                this.compiling = null;
            }, { immediate: true, compileOnly: true });
            P('variable', function () { this.define(this.nameArg(), { data: this.allot(1) }); });
            P('constant', function () { const v = this.pop(); this.define(this.nameArg(), { prim() { this.push(v); }, constant: v }); });
            P('value', function () {
                const addr = this.allot(1);
                this.mem[addr] = this.pop();
                this.define(this.nameArg(), { prim() { this.push(this.fetch(addr)); }, valueAddr: addr });
            });
            this.prim('to', function () {
                const w = this.find(this.nameArg());
                if (!w || w.valueAddr === undefined) fail('not a VALUE');
                if (this.compiling) this.compiling.code.push({ op: 'lit', v: w.valueAddr }, { op: 'call', w: this.find('!') });
                else this.store(w.valueAddr, this.pop());
            }, { immediate: true });
            P('create', function () { this.define(this.nameArg(), { data: this.here }); });
            I('does>', function () { this.code().push({ op: 'does' }); });
            P("'", function () {
                const w = this.find(this.nameArg());
                if (!w) fail('undefined word');
                this.push(w.xt);
            });
            I("[']", function () {
                const w = this.find(this.nameArg());
                if (!w) fail('undefined word');
                this.code().push({ op: 'lit', v: w.xt });
            });
            P('execute', function () {
                const w = this.xts[this.pop()];
                if (!w) fail('invalid execution token');
                this.execute(w);
            });
            I('recurse', function () { this.code().push({ op: 'call', w: { name: this.compiling.name, code: this.compiling.code } }); });
            I('exit', function () { this.code().push({ op: 'exit' }); });
            I('literal', function () { this.code().push({ op: 'lit', v: this.pop() }); });
            P('char', function () { this.push(this.nameArg().charCodeAt(0)); });
            I('[char]', function () { this.code().push({ op: 'lit', v: this.nameArg().charCodeAt(0) }); });

            // control flow
            I('if', function () { const c = { op: '0branch', to: -1 }; this.code().push(c); this.cs.push({ type: 'if', c }); });
            I('else', function () {
                const e = this.csPop('if');
                const c = { op: 'branch', to: -1 };
                this.code().push(c);
                e.c.to = this.code().length;
                this.cs.push({ type: 'if', c });
            });
            I('then', function () { this.csPop('if').c.to = this.code().length; });
            I('begin', function () { this.cs.push({ type: 'begin', at: this.code().length }); });
            I('until', function () { this.code().push({ op: '0branch', to: this.csPop('begin').at }); });
            I('again', function () { this.code().push({ op: 'branch', to: this.csPop('begin').at }); });
            I('while', function () {
                const c = { op: '0branch', to: -1 };
                this.code().push(c);
                const b = this.csPop('begin');
                this.cs.push({ type: 'while', at: b.at, c });
            });
            I('repeat', function () {
                const e = this.csPop('while');
                this.code().push({ op: 'branch', to: e.at });
                e.c.to = this.code().length;
            });
            const doLoop = op => function () {
                const c = { op, end: -1 };
                this.code().push(c);
                this.cs.push({ type: 'do', c, at: this.code().length, leaves: [] });
            };
            I('do', doLoop('do'));
            I('?do', doLoop('?do'));
            const endLoop = op => function () {
                const e = this.csPop('do');
                this.code().push({ op, to: e.at });
                const end = this.code().length;
                e.c.end = end;
                for (const l of e.leaves) l.to = end;
            };
            I('loop', endLoop('loop'));
            I('+loop', endLoop('+loop'));
            I('leave', function () {
                const e = [...this.cs].reverse().find(x => x.type === 'do');
                if (!e) fail('LEAVE outside DO');
                const c = { op: 'leave', to: -1 };
                e.leaves.push(c);
                this.code().push(c);
            });
            P('unloop', function () { if (this.rstack.length < 2) fail('return stack underflow'); this.rstack.length -= 2; }, { compileOnly: true });
            P('i', function () { if (this.rstack.length < 2) fail('I outside DO'); this.push(this.rstack[this.rstack.length - 1]); }, { compileOnly: true });
            P('j', function () { if (this.rstack.length < 4) fail('J outside nested DO'); this.push(this.rstack[this.rstack.length - 3]); }, { compileOnly: true });

            // strings and comments
            this.prim('."', function () {
                const s = this.parseUntil('"');
                if (this.compiling) this.compiling.code.push({ op: 'str', s });
                else this.emit(s);
            }, { immediate: true });
            this.prim('s"', function () {
                const s = this.parseUntil('"');
                const addr = this.storeString(s);
                if (this.compiling) this.compiling.code.push({ op: 'lit', v: addr }, { op: 'lit', v: s.length });
                else { this.push(addr); this.push(s.length); }
            }, { immediate: true });
            this.prim('.(', function () { this.emit(this.parseUntil(')')); }, { immediate: true });
            this.prim('(', function () { this.parseUntil(')'); }, { immediate: true });
            this.prim('\\', function () { this.pos = this.src.length; }, { immediate: true });

            // compiler extensions
            P('immediate', function () {
                if (!this.latest || this.latest.builtin) fail('no word to make immediate');
                this.latest.immediate = true;
            });
            I('postpone', function () {
                const w = this.find(this.nameArg());
                if (!w) fail('undefined word');
                // Immediate words run when the new word runs; others get compiled then
                this.code().push(w.immediate ? { op: 'call', w } : { op: 'compile', w });
            });
            I('[', function () { this.paused = true; });
            P(']', function () {
                if (!this.compiling) fail('] outside a definition');
                this.paused = false;
            });
            P('compile,', function () {
                const w = this.xts[this.pop()];
                if (!w) fail('invalid execution token');
                this.code().push({ op: 'call', w });
            });

            // case
            I('case', function () { this.code(); this.cs.push({ type: 'case', exits: [] }); });
            I('of', function () {
                const c = { op: 'of', to: -1 };
                this.code().push(c);
                this.cs.push({ type: 'of', c });
            });
            I('endof', function () {
                const of = this.csPop('of');
                const kase = this.cs[this.cs.length - 1];
                if (!kase || kase.type !== 'case') fail('unbalanced control structure');
                const exit = { op: 'branch', to: -1 };
                this.code().push(exit);
                kase.exits.push(exit);
                of.c.to = this.code().length;
            });
            I('endcase', function () {
                const kase = this.csPop('case');
                this.code().push({ op: 'call', w: this.find('drop') });
                const end = this.code().length;
                for (const e of kase.exits) e.to = end;
            });

            // dictionary management
            P('marker', function () {
                const snapshot = { dict: new Map(this.dict), xts: this.xts.length, here: this.here, latest: this.latest };
                this.define(this.nameArg(), {
                    prim() {
                        this.dict = snapshot.dict;
                        this.xts.length = snapshot.xts;
                        this.here = snapshot.here;
                        this.mem.length = snapshot.here;
                        this.latest = snapshot.latest;
                        this.version++;
                    }
                });
            });
            P('forget', function () {
                const w = this.find(this.nameArg());
                if (!w) fail('undefined word');
                if (w.builtin) fail('cannot forget a built-in word');
                this.xts.length = w.xt;
                this.dict = new Map();
                for (const x of this.xts) this.dict.set(x.name, x);
                this.latest = this.xts[this.xts.length - 1];
                this.version++;
            });

            // double cells
            P('2variable', function () { this.define(this.nameArg(), { data: this.allot(2) }); });
            P('2constant', function () {
                const hi = this.pop(), lo = this.pop();
                this.define(this.nameArg(), { prim() { this.push(lo); this.push(hi); } });
            });
            P('2!', function () { const a = this.pop(); this.store(a, this.pop()); this.store(a + 1, this.pop()); });
            P('2@', function () { const a = this.pop(); this.push(this.fetch(a + 1)); this.push(this.fetch(a)); });
            P('s>d', function () { const n = this.pop(); this.push(n); this.push(n < 0 ? -1 : 0); });
            P('d.', function () { this.emit(this.popD().toString(this.base).toUpperCase() + ' '); });

            // pictured numeric output
            P('<#', function () { this.pic = ''; });
            P('#', function () {
                const d = this.popD();
                if (d < 0) fail('# needs an unsigned number');
                this.pic = (d % this.base).toString(this.base).toUpperCase() + this.pic;
                this.pushD(Math.floor(d / this.base));
            });
            P('#s', function () {
                let d = this.popD();
                if (d < 0) fail('#S needs an unsigned number');
                do {
                    this.pic = (d % this.base).toString(this.base).toUpperCase() + this.pic;
                    d = Math.floor(d / this.base);
                } while (d > 0);
                this.pushD(0);
            });
            P('hold', function () { this.pic = String.fromCharCode(this.pop()) + this.pic; });
            P('sign', function () { if (this.pop() < 0) this.pic = '-' + this.pic; });
            P('#>', function () {
                this.popD();
                if (this.picAddr === undefined) this.picAddr = this.allot(128);
                const s = this.pic.slice(-128);
                for (let i = 0; i < s.length; i++) this.mem[this.picAddr + i] = s.charCodeAt(i);
                this.push(this.picAddr);
                this.push(s.length);
            });

            // keyboard input and time
            P('key', function () {
                if (this.keys.length) this.push(this.keys.shift());
                else this.state = 'key';
            });
            P('key?', function () { this.push(this.keys.length ? -1 : 0); });
            P('accept', function () {
                const max = this.pop(), addr = this.pop();
                if (max < 0) fail('invalid length');
                this.pending = { addr, max };
                this.state = 'accept';
            });
            P('ms', function () {
                const ms = this.pop();
                if (ms > 0) { this.wakeAt = Date.now() + ms; this.state = 'sleep'; }
            });

            // floating point (separate float stack)
            const F = (n, fn) => this.prim(n, fn);
            const fbin = fn => function () { const b = this.fpop(), a = this.fpop(); this.fpush(fn(a, b)); };
            const fun = fn => function () { this.fpush(fn(this.fpop())); };
            F('f+', fbin((a, b) => a + b));
            F('f-', fbin((a, b) => a - b));
            F('f*', fbin((a, b) => a * b));
            F('f/', fbin((a, b) => { if (b === 0) fail('division by zero'); return a / b; }));
            F('f**', fbin(Math.pow));
            F('fmin', fbin(Math.min));
            F('fmax', fbin(Math.max));
            F('fnegate', fun(a => -a));
            F('fabs', fun(Math.abs));
            F('fsqrt', fun(a => { if (a < 0) fail('invalid argument'); return Math.sqrt(a); }));
            F('fsin', fun(Math.sin));
            F('fcos', fun(Math.cos));
            F('ftan', fun(Math.tan));
            F('fatan', fun(Math.atan));
            F('fexp', fun(Math.exp));
            F('fln', fun(a => { if (a <= 0) fail('invalid argument'); return Math.log(a); }));
            F('flog', fun(a => { if (a <= 0) fail('invalid argument'); return Math.log10(a); }));
            F('floor', fun(Math.floor));
            F('fround', fun(Math.round));
            F('fdup', function () { const a = this.fpop(); this.fpush(a); this.fpush(a); });
            F('fdrop', function () { this.fpop(); });
            F('fswap', function () { const b = this.fpop(), a = this.fpop(); this.fpush(b); this.fpush(a); });
            F('fover', function () { const b = this.fpop(), a = this.fpop(); this.fpush(a); this.fpush(b); this.fpush(a); });
            F('frot', function () { const c = this.fpop(), b = this.fpop(), a = this.fpop(); this.fpush(b); this.fpush(c); this.fpush(a); });
            F('fdepth', function () { this.push(this.fstack.length); });
            F('s>f', function () { this.fpush(this.pop()); });
            F('f>s', function () { this.push(Math.trunc(this.fpop()) | 0); });
            F('f=', function () { const b = this.fpop(), a = this.fpop(); this.push(a === b ? -1 : 0); });
            F('f<', function () { const b = this.fpop(), a = this.fpop(); this.push(a < b ? -1 : 0); });
            F('f0=', function () { this.push(this.fpop() === 0 ? -1 : 0); });
            F('f0<', function () { this.push(this.fpop() < 0 ? -1 : 0); });
            F('f.', function () { this.emit(this.fmtFloat(this.fpop()) + ' '); });
            F('f.s', function () { this.emit(`<${this.fstack.length}> ` + this.fstack.map(v => this.fmtFloat(v) + ' ').join('')); });
            F('pi', function () { this.fpush(Math.PI); });
            F('f@', function () { const v = this.fetch(this.pop()); this.fpush(typeof v === 'number' ? v : 0); });
            F('f!', function () { const a = this.pop(); this.store(a, this.fpop()); });
            F('fvariable', function () { this.define(this.nameArg(), { data: this.allot(1) }); });
            F('fconstant', function () { const v = this.fpop(); this.define(this.nameArg(), { prim() { this.fpush(v); }, fconstant: v }); });

            // tools
            P('words', function () {
                const names = [...this.dict.keys()].reverse();
                if (this.column > 0) this.newline();
                this.emit(names.join(' '));
                this.newline();
            });
            P('see', function () {
                const name = this.nameArg();
                const w = this.find(name);
                if (!w) fail('undefined word');
                if (this.column > 0) this.newline();
                if (w.source) this.emit(w.source);
                else if (w.constant !== undefined) this.emit(`${this.fmt(w.constant)} constant ${w.name}`);
                else if (w.fconstant !== undefined) this.emit(`${this.fmtFloat(w.fconstant)} fconstant ${w.name}`);
                else if (w.valueAddr !== undefined) this.emit(`value ${w.name}`);
                else if (w.data !== undefined) this.emit(`create ${w.name}`);
                else this.emit(`${w.name} is a built-in word`);
                this.newline();
            });
            P('help', function () {
                if (this.column > 0) this.newline();
                [
                    'Type Forth words separated by spaces, then Enter.',
                    '  2 3 + .            prints 5',
                    '  : square dup * ;   defines a new word',
                    '  5 square .         prints 25',
                    'WORDS lists every word, SEE <name> shows a definition.',
                    'SAVE <name> / LOAD <name> / FILES / DELETE <name> keep your',
                    'definitions in the browser. COLD resets everything.',
                    'Floats: 1.5 2e0 f+ f.   Input: key accept   Pause: 500 ms',
                    'Esc interrupts a running word. Tab completes a word.'
                ].forEach(l => { this.emit(l); this.newline(); });
            });
            P('cold', function () {
                const out = this.out, storage = this.storage, onDefine = this.onDefine;
                this.cold();
                this.out = out; this.storage = storage; this.onDefine = onDefine;
                out('', 'cls');
                this.emit('Dictionary reset.');
                this.newline();
                if (this.onDefine) this.onDefine();
            });

            // persistence
            P('save', function () {
                const name = this.nameArg().toLowerCase();
                const data = JSON.stringify({ lines: this.defLines, timestamp: new Date().toISOString() });
                if (!this.storage.set(STORAGE_PREFIX + name, data)) fail('save failed');
                this.emit(`saved ${this.defLines.length} lines as "${name}" `);
            });
            P('load', function () {
                const name = this.nameArg().toLowerCase();
                const raw = this.storage.get(STORAGE_PREFIX + name);
                if (!raw) fail('no saved program named ' + name);
                let data;
                try { data = JSON.parse(raw); } catch (e) { fail('corrupt saved program'); }
                const lines = Array.isArray(data.lines) ? data.lines : legacyLines(data);
                // Replay after the current line
                this.queue.unshift(...lines.map(text => ({ text, interactive: false })));
                this.emit(`loading "${name}" `);
            });
            P('files', function () {
                const names = this.storage.keys().filter(k => k.startsWith(STORAGE_PREFIX)).map(k => k.slice(STORAGE_PREFIX.length)).sort();
                this.emit(names.length ? names.join(' ') + ' ' : 'no saved programs ');
            });
            P('delete', function () {
                const name = this.nameArg().toLowerCase();
                if (!this.storage.get(STORAGE_PREFIX + name)) fail('no saved program named ' + name);
                this.storage.remove(STORAGE_PREFIX + name);
                this.emit(`deleted "${name}" `);
            });
        }

        /** Names of words that complete the given prefix. */
        complete(prefix) {
            const p = prefix.toLowerCase();
            return [...this.dict.keys()].filter(n => n.startsWith(p)).sort();
        }
    }

    /** Programs saved by the original jsforth: {stack, definitions: {name: body}}. */
    function legacyLines(data) {
        return Object.entries(data.definitions || {}).map(([n, body]) => `: ${n} ${body} ;`);
    }

    const EXAMPLES = {
        basics: {
            title: 'Basics',
            src: `\\ Arithmetic works on a stack: operands first, then the operator.
: square ( n -- n*n ) dup * ;
: cube ( n -- n^3 ) dup square * ;
: average ( a b -- avg ) + 2 / ;`,
            try: '7 square .  3 cube .  10 20 average .'
        },
        factorial: {
            title: 'Factorial',
            src: `\\ Recursive and iterative factorial
: fact ( n -- n! ) dup 1 > if dup 1- recurse * else drop 1 then ;
: fact-loop ( n -- n! ) 1 swap 1+ 1 ?do i * loop ;
: facts ( n -- ) 1+ 1 do i 2 .r ." ! = " i fact . cr loop ;`,
            try: '10 facts'
        },
        fibonacci: {
            title: 'Fibonacci',
            src: `\\ Print the first n Fibonacci numbers
: fibs ( n -- ) 0 1 rot 0 do over . tuck + loop 2drop ;`,
            try: '20 fibs'
        },
        fizzbuzz: {
            title: 'FizzBuzz',
            src: `: fizz? ( n -- f ) 3 mod 0= ;
: buzz? ( n -- f ) 5 mod 0= ;
: .fizzbuzz ( n -- )
  dup fizz? over buzz? and if drop ." FizzBuzz" exit then
  dup fizz? if drop ." Fizz" exit then
  dup buzz? if drop ." Buzz" exit then
  . ;
: fizzbuzz ( n -- ) 1+ 1 do i .fizzbuzz space loop ;`,
            try: '30 fizzbuzz'
        },
        primes: {
            title: 'Prime Sieve',
            src: `\\ Sieve of Eratosthenes using CREATE / ALLOT
1000 constant limit
create sieve limit allot
: clear-sieve limit 0 do 1 sieve i + c! loop ;
: prime? ( n -- f ) sieve + c@ ;
: strike ( n -- ) dup dup * begin dup limit < while 0 over sieve + c! over + repeat 2drop ;
: primes ( n -- ) clear-sieve limit 2 do i prime? if i strike then loop
  2 do i prime? if i . then loop ;`,
            try: '100 primes'
        },
        stars: {
            title: 'Star Pyramid',
            src: `: stars ( n -- ) 0 ?do [char] * emit loop ;
: pyramid ( n -- ) dup 0 do cr dup i - 1- spaces i 2* 1+ stars loop drop ;`,
            try: '8 pyramid'
        },
        gcd: {
            title: 'GCD & LCM',
            src: `: gcd ( a b -- n ) begin ?dup while tuck mod repeat ;
: lcm ( a b -- n ) 2dup gcd */ ;`,
            try: '48 36 gcd .  4 6 lcm .'
        },
        counter: {
            title: 'Variables',
            src: `\\ VARIABLE, VALUE and CONSTANT
variable count
0 value best
42 constant answer
: tick ( -- ) 1 count +! ;
: record ( n -- ) dup best > if to best else drop then ;`,
            try: 'tick tick tick count ?  7 record 3 record best .  answer .'
        },
        arrays: {
            title: 'CREATE DOES>',
            src: `\\ A defining word for arrays: n array name
: array ( n -- ) create cells allot does> ( i -- addr ) swap cells + ;
10 array squares
: fill-squares 10 0 do i i * i squares ! loop ;
: .squares 10 0 do i squares @ . loop ;`,
            try: 'fill-squares .squares'
        },
        countdown: {
            title: 'Countdown',
            src: `\\ MS pauses without freezing the page
: countdown ( n -- ) 0 swap do i . 300 ms -1 +loop ." Liftoff!" ;`,
            try: '10 countdown'
        },
        floats: {
            title: 'Floating point',
            src: `\\ Floats live on their own stack
: circle ( r -- ) fdup fdup f* pi f* ." area " f. 2e0 f* pi f* ." circumference " f. ;
: hypot ( a b -- c ) fdup f* fswap fdup f* f+ fsqrt ;`,
            try: '1.5 circle cr 3e0 4e0 hypot f.'
        },
        dice: {
            title: 'CASE & KEY',
            src: `\\ Roll dice until you press q
: .face ( n -- ) case 1 of ." one" endof 2 of ." two" endof 3 of ." three" endof
  4 of ." four" endof 5 of ." five" endof ." six" endcase ;
: roll-dice ( -- ) cr ." Press any key to roll, q to quit" cr
  begin key [char] q <> while 6 random 1+ .face space repeat ;`,
            try: 'roll-dice'
        },
        format: {
            title: 'Number formatting',
            src: `\\ Pictured numeric output: show cents as dollars
: .$ ( cents -- ) dup abs 0 <# # # [char] . hold #s [char] $ hold rot sign #> type ;
: table ( -- ) 6 1 do i 1234 * dup . ." -> " .$ cr loop ;`,
            try: 'table -999 .$'
        },
        hanoi: {
            title: 'Towers of Hanoi',
            src: `\\ Move n discs from peg "from" to peg "to", using peg "via"
variable moves
: move-disc ( from to -- ) 1 moves +! swap . ." -> " . cr ;
: hanoi ( n from to via -- )
  3 pick 0= if 2drop 2drop exit then
  3 pick 1- 3 pick 2 pick 4 pick recurse   \\ n-1 discs: from -> via
  2 pick 2 pick move-disc                  \\ largest disc: from -> to
  3 pick 1- over 3 pick 5 pick recurse     \\ n-1 discs: via -> to
  2drop 2drop ;`,
            try: '0 moves ! 3 1 3 2 hanoi moves ? .( moves)'
        }
    };

    const api = { Forth, ForthError, EXAMPLES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ForthCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
