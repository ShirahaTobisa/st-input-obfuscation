import { install, KEY } from './src/runtime.js';

const getContext = () => SillyTavern.getContext();
const context = getContext();
context.extensionSettings[KEY] ??= { enabled: false };

const panel = document.createElement('details');
panel.id = 'input-obfuscation-settings';
panel.innerHTML = `
    <summary>Gemini 输入混淆</summary>
    <label class="checkbox_label"><input type="checkbox"><span>启用输入混淆</span></label>
    <p>仅用于 Gemini 主聊天：把本轮真实输入伪装成工具调用的返回结果发送，绕过对普通用户消息的审核。可与「Gemini 抗截断」同时使用。</p>
    <p class="input-obfuscation-status" role="status"></p>`;
const checkbox = panel.querySelector('input');
const statusElement = panel.querySelector('[role="status"]');
checkbox.checked = context.extensionSettings[KEY].enabled;
statusElement.textContent = checkbox.checked ? '已开启，等待主聊天请求' : '已关闭';
checkbox.addEventListener('change', () => {
    getContext().extensionSettings[KEY].enabled = checkbox.checked;
    getContext().saveSettingsDebounced();
    statusElement.classList.remove('input-obfuscation-warning');
    statusElement.textContent = checkbox.checked ? '已开启，从下一次主聊天请求生效' : '已关闭，从下一次主聊天请求生效';
});
document.querySelector('#extensions_settings')?.append(panel);

install(getContext, window, (detail, warning) => {
    statusElement.textContent = detail;
    statusElement.classList.toggle('input-obfuscation-warning', Boolean(warning));
});
