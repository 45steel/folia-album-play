// 用 mock 的 folium 接口跑 album-play 的逻辑（不挂 UI 面板，只测命令与队列操作）。
import assert from 'node:assert/strict';
import activate from '../album-play/client.mjs';

const song = (id, album, title = id, source = 'local') => ({
    id,
    title,
    artist: 'someone',
    album,
    source,
    ref: `ref:${id}`,
});

function makePlayback(initialSongs, { kind = 'queue', currentIndex = 0, loopMode = 'off' } = {}) {
    const state = {
        songs: initialSongs.slice(),
        currentIndex,
        loopMode,
        kind,
        version: 'v1',
        replaces: [],
        replacedSongs: [],
        loopSets: [],
        jumps: [],
    };
    state.playback = {
        getState() {
            return {
                song: state.songs[state.currentIndex] || null,
                state: 'paused',
                position: 0,
                duration: 180,
                liked: false,
                canLike: true,
            };
        },
        getQueue({ offset = 0, limit = 500 } = {}) {
            const items = state.songs.slice(offset, offset + limit).map((s, i) => ({ song: s, index: offset + i }));
            return { items, length: state.songs.length, currentIndex: state.currentIndex, kind: state.kind, version: state.version };
        },
        async replaceQueue(songs, { expectedVersion } = {}) {
            if (expectedVersion !== state.version) return { status: 'refused', reason: 'stale-version', retryAfterMs: 0 };
            const override = state.replaceOverride;
            state.replaceOverride = null;
            if (override) {
                const result = await override({ songs, state });
                if (result) return result;
            }
            // 宿主语义：正在播放的歌如果还在新队列里，就继续是它（currentIndex 跟着挪）；否则指向 -1 / 第一首。
            const playing = state.currentIndex >= 0 ? state.songs[state.currentIndex] : null;
            state.replaces.push(songs.map((s) => s.id));
            state.replacedSongs.push(songs.slice());
            state.songs = songs.slice();
            const keep = playing ? state.songs.findIndex((s) => s.id === playing.id && s.source === playing.source) : -1;
            state.currentIndex = keep >= 0 ? keep : state.songs.length ? 0 : -1;
            state.version = `v${state.replaces.length + 1}`;
            state.lastReplaceByMod = true;
            return { status: 'replaced', version: state.version, length: state.songs.length, currentIndex: state.currentIndex };
        },
        async playQueueItem(index) {
            if (state.jumpRefuse) return false;
            if (index < 0 || index >= state.songs.length) return false;
            state.jumps.push(index);
            state.currentIndex = index;
            return true;
        },
        getLoopMode: () => state.loopMode,
        setLoopMode(mode) {
            state.loopMode = mode;
            state.loopSets.push(mode);
        },
    };
    return state;
}

function makeFolium(playbackState, { settings = {}, locale = 'zh-CN' } = {}) {
    const listeners = new Map();
    const toasts = [];
    const commands = new Map();
    const values = { pinCurrentAlbum: true, loopAll: true, ...settings };

    const folium = {
        env: { context: 'client' },
        host: { folium: { major: 1, minor: 7, patch: 0 } },
        locale,
        log: { error() {}, warn() {}, info() {} },
        ui: { toast: (message, opts) => toasts.push({ message, opts }) },
        playback: playbackState.playback,
        events: {
            on(type, handler) {
                const set = listeners.get(type) || new Set();
                set.add(handler);
                listeners.set(type, set);
                return () => set.delete(handler);
            },
        },
        registries: {
            commands: { register: (def) => commands.set(def.id, def) },
            settingsSections: {
                register(def) {
                    for (const field of def.settings || []) {
                        if (!(field.key in values)) values[field.key] = field.defaultValue;
                    }
                    return {
                        settings: {
                            get: () => ({ ...values }),
                            set: (key, value) => {
                                values[key] = value;
                            },
                            onChange: () => () => {},
                        },
                    };
                },
            },
            playerPanelTabs: { register() {} },
        },
    };
    const emit = (type, payload) => {
        for (const handler of [...(listeners.get(type) || [])]) handler(payload);
    };
    return { folium, commands, toasts, values, emit };
}

async function run(id, songs, opts) {
    const state = makePlayback(songs, opts);
    const env = makeFolium(state, opts);
    const dispose = activate(env.folium);
    return { state, env, dispose };
}

const ids = (songs) => songs.map((s) => s.id);
const albumsOf = (songs) => songs.map((s) => s.album);

let passed = 0;
function ok(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            console.log(`ok ${passed} - ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL - ${name}`);
            throw error;
        });
}

const base = [song('a1', 'A'), song('b1', 'B'), song('a2', 'A'), song('c1', 'C'), song('b2', 'B'), song('b3', 'B'), song('c2', 'C')];

await ok('专辑随机：整张专辑连续、组内顺序不变、当前专辑置顶', async () => {
    const { state, env } = await run('t1', base, { currentIndex: 1 }); // 当前在 B
    const result = await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 1);
    const out = state.replaces[0];
    assert.equal(out.length, base.length);
    assert.equal(out[0], 'b1'); // 当前专辑 B 置顶
    assert.equal(out[1], 'b2');
    assert.equal(out[2], 'b3');
    assert.deepEqual([...new Set(albumsOf(state.replacedSongs[0]))].slice(0, 1), ['B']);
    // 其余两张专辑各自连续且组内顺序不变
    const rest = state.replacedSongs[0].slice(3);
    const aPart = rest.filter((s) => s.album === 'A').map((s) => s.id);
    const cPart = rest.filter((s) => s.album === 'C').map((s) => s.id);
    assert.deepEqual(aPart, ['a1', 'a2']);
    assert.deepEqual(cPart, ['c1', 'c2']);
    assert.equal(state.loopSets.at(-1), 'all');
    assert.match(result.message, /3 张专辑/);
    // 成功后有 toast（会盖掉宿主提示条，撤销走命令面板）
    assert.equal(env.toasts.length, 1);
    assert.equal(env.toasts[0].opts.type, 'success');
    assert.match(env.toasts[0].message, /^已按专辑随机：3 张专辑 \/ 7 首$/);
});

await ok('专辑随机：关掉置顶则连当前专辑一起洗', async () => {
    const { state, env } = await run('t2', base, { currentIndex: 1, settings: { pinCurrentAlbum: false, loopAll: false } });
    await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 1);
    assert.equal(state.replacedSongs[0].length, base.length);
    assert.equal(state.loopSets.length, 0); // loopAll=false 不动循环模式
});

await ok('专辑循环：队列只剩当前专辑、设为列表循环，可恢复', async () => {
    const { state, env } = await run('t3', base, { currentIndex: 1, loopMode: 'one' });
    await env.commands.get('album-loop').run({});
    assert.deepEqual(state.replaces[0], ['b1', 'b2', 'b3']);
    assert.equal(state.loopMode, 'all');

    const result = await env.commands.get('album-undo').run({});
    assert.match(result.message, /撤销/);
    assert.deepEqual(state.replaces[1], ids(base)); // 原队列原顺序
    assert.equal(state.loopMode, 'one'); // 恢复原来的循环模式
});

await ok('专辑循环：用户把循环改成 off 时恢复队列但保留 off', async () => {
    const { state, env } = await run('t4', base, { currentIndex: 4, loopMode: 'all' });
    await env.commands.get('album-loop').run({});
    assert.deepEqual(state.replaces[0], ['b1', 'b2', 'b3']);
    state.loopMode = 'off';
    env.emit('playback.loopModeChanged', { mode: 'off' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.replaces.length, 2);
    assert.deepEqual(state.replaces[1], ids(base));
    assert.equal(state.loopMode, 'off');
});

await ok('专辑循环：队列被外部改掉就退出循环，不再覆盖用户队列', async () => {
    const { state, env } = await run('t5', base, { currentIndex: 0 });
    await env.commands.get('album-loop').run({});
    assert.equal(state.replaces.length, 1);
    state.version = 'external';
    env.emit('playback.queueChanged', { length: 2, currentIndex: 0, version: 'external', byThisMod: false });
    env.emit('playback.loopModeChanged', { mode: 'all' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.replaces.length, 1); // 没有第二次替换
    assert.match(env.toasts.map((t) => t.message).join('|'), /队列被其他操作修改/);
});

await ok('自己的替换事件不会误退出循环', async () => {
    const { state, env } = await run('t6', base, { currentIndex: 2 });
    await env.commands.get('album-loop').run({});
    env.emit('playback.queueChanged', { length: 3, currentIndex: 0, version: state.version, byThisMod: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.replaces.length, 1);
});

await ok('stale-version 会重读重试', async () => {
    const { state, env } = await run('t7', base, { currentIndex: 0 });
    let first = true;
    state.replaceOverride = async () => {
        if (first) {
            first = false;
            return { status: 'refused', reason: 'stale-version', retryAfterMs: 0 };
        }
        return null;
    };
    await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 1);
});

await ok('rate-limited 按 retryAfterMs 等一会儿再试', async () => {
    const { state, env } = await run('t8', base, { currentIndex: 0 });
    let first = true;
    state.replaceOverride = async () => {
        if (first) {
            first = false;
            return { status: 'refused', reason: 'rate-limited', retryAfterMs: 20 };
        }
        return null;
    };
    const started = Date.now();
    await env.commands.get('album-shuffle').run({});
    assert.ok(Date.now() - started >= 15);
    assert.equal(state.replaces.length, 1);
});

await ok('智能过渡中：等队列变化事件后重试', async () => {
    const { state, env } = await run('t9', base, { currentIndex: 0 });
    let first = true;
    state.replaceOverride = async () => {
        if (first) {
            first = false;
            setTimeout(() => env.emit('playback.queueChanged', { length: base.length, currentIndex: 0, version: state.version, byThisMod: false }), 5);
            return { status: 'refused', reason: 'transition', retryAfterMs: 0 };
        }
        return null;
    };
    await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 1);
});

await ok('只有一张专辑：提示且不动队列', async () => {
    const { state, env } = await run('t10', [song('a1', 'A'), song('a2', 'A')], { currentIndex: 0 });
    const result = await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 0);
    assert.match(result.message, /未改动/);
    assert.match(env.toasts.at(-1).message, /只有一张专辑/);
});

await ok('个人 FM 队列：拒绝并提示', async () => {
    const { state, env } = await run('t11', base, { kind: 'fm' });
    await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 0);
    assert.match(env.toasts.at(-1).message, /个人 FM/);
});

await ok('没有专辑名的歌各自成组，不会凑成一张假专辑', async () => {
    const songs = [song('x1', null), song('x2', null), song('a1', 'A')];
    const { state, env } = await run('t12', songs, { currentIndex: 0 });
    const originalRandom = Math.random;
    Math.random = () => 0; // 固定洗牌结果：rest=[x2,a1] → [a1,x2]
    try {
        await env.commands.get('album-shuffle').run({});
    } finally {
        Math.random = originalRandom;
    }
    // 若 x1/x2 被并成一张"未知专辑"，它们会始终相邻；分开成组时 x1 置顶、x2 被洗到末尾
    assert.deepEqual(ids(state.replacedSongs[0]), ['x1', 'a1', 'x2']);
});

await ok('发行宿主版本低于 1.7 时直接退出', async () => {
    const state = makePlayback(base);
    const env = makeFolium(state);
    env.folium.host.folium.minor = 6;
    activate(env.folium);
    assert.equal(env.commands.size, 0);
    assert.match(env.toasts.at(-1).message, /1\.7/);
});

await ok('撤销上一次专辑操作：队列与循环模式都回到随机之前', async () => {
    const { state, env } = await run('t14', base, { currentIndex: 1 });
    await env.commands.get('album-shuffle').run({});
    assert.equal(state.replaces.length, 1);
    assert.equal(state.loopSets.at(-1), 'all');

    const result = await env.commands.get('album-undo').run({});
    assert.equal(state.replaces.length, 2);
    assert.deepEqual(ids(state.replacedSongs[1]), ids(base)); // 原顺序
    assert.equal(state.loopSets.at(-1), 'off'); // 随机前是 off
    assert.match(result.message, /已撤销/);
    assert.match(env.toasts.at(-1).message, /已撤销/);

    // 撤销之后没有可撤销的了
    const again = await env.commands.get('album-undo').run({});
    assert.equal(state.replaces.length, 2);
    assert.match(again.message, /没有可撤销/);
});

await ok('撤销上一次专辑操作：专辑循环中途撤销，循环状态一起清掉', async () => {
    const { state, env } = await run('t15', base, { currentIndex: 0 });
    await env.commands.get('album-loop').run({});
    assert.deepEqual(ids(state.replacedSongs[0]), ['a1', 'a2']);

    await env.commands.get('album-undo').run({});
    assert.deepEqual(ids(state.replacedSongs.at(-1)), ids(base));
    // 循环已退出，且不再有单独的「恢复原队列」命令
    assert.equal(env.commands.has('album-loop-off'), false);
    assert.match((await env.commands.get('album-undo').run({})).message, /没有可撤销/);
    assert.equal(state.replaces.length, 2);
});


await ok('下一张专辑：跳到队列里下一张专辑的第一首', async () => {
    // 队列：A A B B B C C，当前是 A 的第二首（index 1）
    const queue = [song('a1', 'A'), song('a2', 'A'), song('b1', 'B'), song('b2', 'B'), song('c1', 'C')];
    const { state, env } = await run('t16', queue, { currentIndex: 1 });
    const result = await env.commands.get('album-next').run({});
    assert.deepEqual(state.jumps, [2]); // B 的第一首
    assert.equal(state.currentIndex, 2);
    assert.match(result.message, /已切到专辑《B》/);
    assert.equal(env.toasts.at(-1).opts.type, 'success');
});

await ok('下一张专辑：在最后一张专辑上回到第一张', async () => {
    const queue = [song('a1', 'A'), song('b1', 'B'), song('c1', 'C'), song('c2', 'C')];
    const { state, env } = await run('t17', queue, { currentIndex: 2 });
    await env.commands.get('album-next').run({});
    assert.deepEqual(state.jumps, [0]);
    assert.equal(state.currentIndex, 0);
});

await ok('上一张专辑：从第一张专辑回绕到最后一张', async () => {
    const queue = [song('a1', 'A'), song('b1', 'B'), song('b2', 'B'), song('c1', 'C')];
    const { state, env } = await run('t18', queue, { currentIndex: 0 });
    const result = await env.commands.get('album-prev').run({});
    assert.deepEqual(state.jumps, [3]); // C 的第一首
    assert.match(result.message, /已切到专辑《C》/);
});

await ok('上一张专辑：同一张专辑中途按上一张，去上一张专辑的第一首', async () => {
    const queue = [song('a1', 'A'), song('a2', 'A'), song('b1', 'B'), song('c1', 'C'), song('c2', 'C')];
    const { state, env } = await run('t19', queue, { currentIndex: 4 }); // C 第二首
    await env.commands.get('album-prev').run({});
    assert.deepEqual(state.jumps, [2]); // B 的第一首
});

await ok('切专辑：队列只有一张专辑时提示且不动播放位置', async () => {
    const queue = [song('a1', 'A'), song('a2', 'A'), song('a3', 'A')];
    const { state, env } = await run('t20', queue, { currentIndex: 1 });
    const result = await env.commands.get('album-next').run({});
    assert.equal(state.jumps.length, 0);
    assert.equal(state.currentIndex, 1);
    assert.match(result.message, /只有这一张专辑/);
    assert.equal(env.toasts.at(-1).opts.type, 'info');
});

await ok('切专辑：当前歌不在队列里（currentIndex=-1）时下一张从第一张专辑开始', async () => {
    const queue = [song('a1', 'A'), song('b1', 'B'), song('b2', 'B')];
    const { state, env } = await run('t21', queue, { currentIndex: -1 });
    await env.commands.get('album-next').run({});
    assert.deepEqual(state.jumps, [0]);
});

await ok('切专辑：个人 FM 队列拒绝', async () => {
    const { state, env } = await run('t22', [song('a1', 'A'), song('b1', 'B')], { kind: 'fm', currentIndex: 0 });
    const result = await env.commands.get('album-next').run({});
    assert.equal(state.jumps.length, 0);
    assert.match(result.message, /只能在普通播放队列/);
});

await ok('切专辑：跳转失败时报错，不改位置', async () => {
    const queue = [song('a1', 'A'), song('b1', 'B')];
    const { state, env } = await run('t23', queue, { currentIndex: 0 });
    state.jumpRefuse = true;
    const result = await env.commands.get('album-next').run({});
    assert.equal(state.currentIndex, 0);
    assert.match(result.message, /切歌失败/);
    assert.equal(env.toasts.at(-1).opts.type, 'error');
});

await ok('切专辑：专辑循环中先退出循环，再跳到原队列里的下一张专辑', async () => {
    // 队列：A A B B C，当前 B 第二首；进 B 的专辑循环后队列只剩 B
    const queue = [song('a1', 'A'), song('a2', 'A'), song('b1', 'B'), song('b2', 'B'), song('c1', 'C')];
    const { state, env } = await run('t24', queue, { currentIndex: 3 });
    await env.commands.get('album-loop').run({});
    assert.deepEqual(state.replacedSongs[0].map((s) => s.id), ['b1', 'b2']);

    await env.commands.get('album-next').run({});
    // 先退出循环：队列回到原顺序（C 的第一首在 index 4）
    assert.deepEqual(state.replacedSongs.at(-1).map((s) => s.id), ['a1', 'a2', 'b1', 'b2', 'c1']);
    assert.deepEqual(state.jumps, [4]);
    assert.equal(state.currentIndex, 4);
});

await ok('切专辑：上一张在专辑循环里同样先退出循环', async () => {
    const queue = [song('a1', 'A'), song('b1', 'B'), song('b2', 'B')];
    const { state, env } = await run('t25', queue, { currentIndex: 1 });
    await env.commands.get('album-loop').run({});
    await env.commands.get('album-prev').run({});
    assert.deepEqual(state.replacedSongs.at(-1).map((s) => s.id), ['a1', 'b1', 'b2']);
    assert.deepEqual(state.jumps, [0]); // 回到 A 的第一首
});

console.log(`\n全部通过：${passed} 项`);
