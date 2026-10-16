import { isBackgroundGeneration, obfuscateChat, skipReason } from './obfuscate.js';

export const KEY = 'input_obfuscation';
const TOAST_TITLE = 'Gemini 输入混淆';

// ctx.chat 里最后一条真实用户消息的原文（排除系统/隐藏消息）。
function latestUserInput(context) {
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (message?.is_user && !message?.is_system) return String(message.mes ?? '').trim();
    }
    return '';
}

// transformInput：把原话按酒馆发送前的规则改写（index.js 传入“仅格式提示词”的正则），匹配时先用改写后的，再退回原文。
export function install(getContext, host, showStatus, transformInput = (text) => text) {
    const context = getContext();
    const { eventSource: events, eventTypes: types } = context;
    context.extensionSettings[KEY] ??= { enabled: false };
    let generationType = 'normal';

    const onPromptReady = (eventData) => {
        const ctx = getContext();
        const settings = ctx.extensionSettings[KEY];
        // 关着、只是预演（算 token）、后台请求和代写：不动也不提示。
        if (!settings?.enabled || eventData?.dryRun || isBackgroundGeneration(generationType)) return;
        const isChatCompletion = ctx.mainApi === 'openai';
        let model = '';
        // 本来就不适用的环境（不是 Gemini、不是对话补全）只改状态文字；Gemini 环境下没生效才弹窗，因为原话会裸发出去。
        const warn = (text, force = false) => {
            showStatus(text, true);
            if (force || (isChatCompletion && /gemini/i.test(String(model || '')))) host.toastr?.warning?.(text, TOAST_TITLE);
        };
        try {
            model = typeof ctx.getChatCompletionModel === 'function' ? ctx.getChatCompletionModel() : '';
            const reason = skipReason({
                enabled: settings.enabled,
                isChatCompletion,
                model,
                dryRun: eventData?.dryRun,
                generationType,
                postProcessing: ctx.chatCompletionSettings?.custom_prompt_post_processing,
            });
            if (reason) return warn(`本轮未生效：${reason}`);
            // crypto.randomUUID 只在 HTTPS 或 localhost 下存在；取不到时由 obfuscateChat 用随机数兜底。
            const raw = latestUserInput(ctx);
            let transformed = raw;
            try { transformed = String(transformInput(raw) ?? raw); } catch (_) { /* 改写失败就按原文找 */ }
            let result = { applied: false, reason: '没有找到本轮用户输入' };
            for (const text of [...new Set([transformed, raw].filter(Boolean))]) {
                result = obfuscateChat(eventData.chat, text, () => host.crypto?.randomUUID?.());
                if (result.applied || result.reason === '本轮已处理') break;
            }
            if (result.applied) showStatus(`已混淆：本轮输入（${result.movedChars} 字）已作为工具结果传递`, false);
            else warn(`本轮未生效：${result.reason}`);
        } catch (error) {
            // 出错时酒馆仍会把原话发出去，至少要让用户知道。
            warn(`本轮未生效：插件出错（${error?.message || error}）`, true);
        }
    };

    events.on(types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    // 记下这次生成的类型（normal/continue/regenerate/swipe/quiet/impersonate）；提示词就绪事件里拿不到。
    // 同时把自己排到提示词事件的最后：其他读取或修改提示词的扩展（记忆、酒馆助手脚本等）看到的仍是原始内容，
    // 聊天记录本身从头到尾不动。
    events.on(types.GENERATION_STARTED, (type) => {
        generationType = String(type || 'normal');
        events.makeLast?.(types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    });
}
