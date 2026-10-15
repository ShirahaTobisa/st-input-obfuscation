import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, KEY } from '../src/runtime.js';
import { PLACEHOLDER } from '../src/obfuscate.js';

// 用假的酒馆上下文和事件总线跑 runtime：生成类型、后处理设置、HTTP 下没有 randomUUID、出错提示。
function fakeEvents() {
    const handlers = new Map();
    return {
        on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
        makeLast(name, handler) { handlers.set(name, [...(handlers.get(name) || []).filter((item) => item !== handler), handler]); },
        async emit(name, ...args) { for (const handler of handlers.get(name) || []) await handler(...args); },
    };
}

function setup({ model = 'gemini-2.5-pro', mainApi = 'openai', postProcessing = '', enabled = true, crypto = {}, modelThrows = false } = {}) {
    const events = fakeEvents();
    const context = {
        eventSource: events,
        eventTypes: { GENERATION_STARTED: 'generation_started', CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready' },
        extensionSettings: { [KEY]: { enabled } },
        mainApi,
        getChatCompletionModel() { if (modelThrows) throw new Error('boom'); return model; },
        chatCompletionSettings: { custom_prompt_post_processing: postProcessing },
        chat: [{ is_user: false, mes: '你好' }, { is_user: true, mes: '真实输入' }],
    };
    const toasts = [];
    const statuses = [];
    install(() => context, { crypto, toastr: { warning: (text, title) => toasts.push({ text, title }) } }, (detail, warning) => statuses.push({ detail, warning }));
    const send = async ({ type = 'normal', dryRun = false, chat = [{ role: 'user', content: '真实输入' }] } = {}) => {
        await events.emit('generation_started', type, {}, dryRun);
        await events.emit('chat_completion_prompt_ready', { chat, dryRun });
        return chat;
    };
    return { send, toasts, statuses, context, events };
}

test('runs after every other prompt listener, so they still see the original input', async () => {
    const { send, events } = setup();
    const seen = [];
    // 装在我们之后的扩展：读最后一条用户消息，再往后追加一条系统提示。
    events.on('chat_completion_prompt_ready', ({ chat }) => {
        seen.push(chat.at(-1).content);
        chat.push({ role: 'system', content: '后装扩展的注入' });
    });
    const chat = await send();
    assert.deepEqual(seen, ['真实输入']);
    assert.deepEqual(chat.map((m) => m.role), ['user', 'system', 'assistant', 'tool']);
});

test('applies to a normal send even without crypto.randomUUID (plain HTTP)', async () => {
    const { send, toasts, statuses } = setup({ crypto: {} });
    const chat = await send();
    assert.equal(chat[0].content, PLACEHOLDER);
    assert.match(chat[1].tool_calls[0].id, /^call_[a-z0-9]+$/);
    assert.equal(chat[2].tool_call_id, chat[1].tool_calls[0].id);
    assert.deepEqual(toasts, []);
    assert.match(statuses.at(-1).detail, /已混淆：本轮输入（4 字）/);
    assert.equal(statuses.at(-1).warning, false);
});

test('uses crypto.randomUUID when available', async () => {
    const { send } = setup({ crypto: { randomUUID: () => 'uuid-1' } });
    const chat = await send();
    assert.equal(chat[1].tool_calls[0].id, 'call_uuid-1');
});

test('leaves background and impersonate generations alone, silently', async () => {
    const { send, toasts, statuses } = setup();
    for (const type of ['quiet', 'impersonate']) {
        const chat = await send({ type });
        assert.equal(chat.length, 1, type);
        assert.equal(chat[0].content, '真实输入', type);
    }
    assert.deepEqual(toasts, []);
    assert.deepEqual(statuses, []);
});

test('dry runs and the disabled state change nothing and say nothing', async () => {
    for (const { enabled, options } of [{ enabled: true, options: { dryRun: true } }, { enabled: false, options: {} }]) {
        const { send, toasts, statuses } = setup({ enabled });
        const chat = await send(options);
        assert.equal(chat.length, 1);
        assert.deepEqual(toasts, []);
        assert.deepEqual(statuses, []);
    }
});

test('post-processing without tools is refused with a toast', async () => {
    const { send, toasts, statuses } = setup({ postProcessing: 'merge' });
    const chat = await send();
    assert.equal(chat.length, 1);
    assert.match(toasts[0].text, /Prompt Post-Processing/);
    assert.equal(toasts[0].title, 'Gemini 输入混淆');
    assert.equal(statuses.at(-1).warning, true);
    const ok = setup({ postProcessing: 'merge_tools' });
    assert.equal((await ok.send()).length, 3);
});

test('a non-Gemini setup only updates the status text, no toast', async () => {
    const { send, toasts, statuses } = setup({ model: 'gpt-4o' });
    await send();
    assert.deepEqual(toasts, []);
    assert.match(statuses.at(-1).detail, /不是 Gemini/);
});

test('an unmatched input on a Gemini setup warns with a toast', async () => {
    const { send, toasts } = setup();
    await send({ chat: [{ role: 'user', content: '被正则改掉了' }] });
    assert.match(toasts[0].text, /未匹配到用户输入/);
});

test('an unexpected error is reported instead of swallowed', async () => {
    const { send, toasts } = setup({ modelThrows: true });
    await send();
    assert.match(toasts[0]?.text || '', /插件出错.*boom/);
});
