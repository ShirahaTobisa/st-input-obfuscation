import { install, KEY } from './src/runtime.js';

const getContext = () => SillyTavern.getContext();

// 酒馆扩展设置的标准折叠块（inline-drawer），和其他扩展外观一致。
const panel = document.createElement('div');
panel.id = 'input-obfuscation-settings';
panel.className = 'inline-drawer';
panel.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Gemini 输入混淆</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label"><input type="checkbox"><span>启用输入混淆</span></label>
        <p>只对 Gemini 主聊天生效：把本轮真实输入伪装成工具调用的返回结果发送，绕过对普通用户消息的审核。只改发出去的请求，不动聊天记录；总结、生图提示词、「代写」这类请求不处理。可与「Gemini 抗截断」同时使用。</p>
        <p>接口设置里的「Prompt Post-Processing」要选 None 或带 with tools 的档位，否则工具消息会被拆掉。没生效时会弹窗提醒。输入框旁的魔法棒菜单里也有开关。</p>
        <p class="input-obfuscation-status" role="status"></p>
    </div>`;
const checkbox = panel.querySelector('input');
const statusElement = panel.querySelector('[role="status"]');
const showStatus = (detail, warning) => {
    statusElement.textContent = detail;
    statusElement.classList.toggle('input-obfuscation-warning', Boolean(warning));
};

// 输入框旁魔法棒菜单里的快捷开关，聊天时随手切换。
const wand = document.createElement('div');
wand.id = 'input-obfuscation-wand';
wand.className = 'list-group-item flex-container flexGap5';
wand.innerHTML = '<div class="fa-solid extensionsMenuExtensionButton"></div><span></span>';

const setEnabled = (enabled, save = true) => {
    const context = getContext();
    context.extensionSettings[KEY].enabled = enabled;
    if (save) context.saveSettingsDebounced();
    checkbox.checked = enabled;
    wand.querySelector('.extensionsMenuExtensionButton').className = `fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'} extensionsMenuExtensionButton`;
    wand.querySelector('span').textContent = `输入混淆：${enabled ? '开' : '关'}`;
    showStatus(enabled ? '已开启，等待主聊天请求' : '已关闭', false);
};

install(getContext, window, showStatus);
setEnabled(getContext().extensionSettings[KEY].enabled, false);
checkbox.addEventListener('change', () => setEnabled(checkbox.checked));
wand.addEventListener('click', () => setEnabled(!getContext().extensionSettings[KEY].enabled));
(document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings'))?.append(panel);
const mountWand = () => document.querySelector('#extensionsMenu')?.append(wand);
mountWand();
if (!wand.isConnected) getContext().eventSource.on(getContext().eventTypes.APP_READY, mountWand);
