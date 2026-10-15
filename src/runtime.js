import { obfuscateChat, skipReason } from './obfuscate.js';

export const KEY = 'input_obfuscation';

// ctx.chat 里最后一条真实用户消息的原文（排除系统/隐藏消息）。
function latestUserInput(context) {
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (message?.is_user && !message?.is_system) return String(message.mes ?? '').trim();
    }
    return '';
}

export function install(getContext, host, showStatus) {
    const context = getContext();
    const { eventSource: events, eventTypes: types } = context;
    context.extensionSettings[KEY] ??= { enabled: false };

    events.on(types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        const ctx = getContext();
        const settings = ctx.extensionSettings[KEY];
        const reason = skipReason({
            enabled: settings?.enabled,
            isChatCompletion: ctx.mainApi === 'openai',
            model: typeof ctx.getChatCompletionModel === 'function' ? ctx.getChatCompletionModel() : '',
            dryRun: eventData?.dryRun,
        });
        if (reason) {
            if (settings?.enabled && !eventData?.dryRun) showStatus(`本轮未生效：${reason}`, false);
            return;
        }
        const result = obfuscateChat(eventData.chat, latestUserInput(ctx), () => host.crypto.randomUUID());
        showStatus(
            result.applied ? `已混淆：本轮输入（${result.movedChars} 字）已作为工具结果传递` : `本轮未生效：${result.reason}`,
            !result.applied,
        );
    });
}
