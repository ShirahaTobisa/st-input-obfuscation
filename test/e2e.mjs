// 端到端检查：起一个隔离的酒馆实例和一个假的 OpenAI 兼容接口，真发消息，核对实际发出去的 messages。
// 需要：本机酒馆源码（ST_DIR，默认 D:/sillytavern，且扩展已装进它的 third-party 目录）、Chrome（CHROME_PATH）、
// 一个装了 playwright 的目录（PLAYWRIGHT_ROOT）。不动 ST_DIR 里的数据：实例用临时目录当 dataRoot。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ST_DIR = process.env.ST_DIR || 'D:/sillytavern';
const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PLAYWRIGHT_ROOT = process.env.PLAYWRIGHT_ROOT || process.cwd();
const ST_PORT = Number(process.env.ST_PORT || 8011);
const MOCK_PORT = Number(process.env.MOCK_PORT || 8778);
const PANEL = '#input-obfuscation-settings';
const { chromium } = createRequire(path.join(PLAYWRIGHT_ROOT, 'package.json'))('playwright');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasToolPair = (messages) => messages.some((m) => Array.isArray(m.tool_calls)) && messages.some((m) => m.role === 'tool');

// 假接口：记下每个请求，回一句固定回复。
const requests = [];
const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemini-test' }] }));
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'gemini-test', choices: [{ index: 0, message: { role: 'assistant', content: '（模拟回复）收到。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.writeHead(404);
    res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const waitRequest = async (seen) => {
    for (let i = 0; i < 150; i += 1) {
        if (requests.length > seen) return requests[seen];
        await sleep(200);
    }
    throw new Error('假接口 30 秒内没有收到请求');
};

// 隔离的酒馆实例：临时 dataRoot，设置直接指向假接口，扩展默认开启。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-input-obfuscation-'));
fs.writeFileSync(path.join(temp, 'config.yaml'), fs.readFileSync(path.join(ST_DIR, 'config.yaml'), 'utf8').replace(/^port: .*$/m, `port: ${ST_PORT}`));
const settings = JSON.parse(fs.readFileSync(path.join(ST_DIR, 'default/content/settings.json'), 'utf8'));
settings.main_api = 'openai';
Object.assign(settings.oai_settings, { chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${MOCK_PORT}/v1`, custom_model: 'gemini-test', custom_prompt_post_processing: '', stream_openai: false });
settings.extension_settings.input_obfuscation = { enabled: true };
fs.mkdirSync(path.join(temp, 'data/default-user'), { recursive: true });
fs.writeFileSync(path.join(temp, 'data/default-user/settings.json'), JSON.stringify(settings));
const stLog = [];
const st = spawn(process.execPath, ['server.js', '--configPath', path.join(temp, 'config.yaml'), '--dataRoot', path.join(temp, 'data'), '--port', String(ST_PORT), '--browserLaunchEnabled=false'], { cwd: ST_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [st.stdout, st.stderr]) stream.on('data', (chunk) => stLog.push(String(chunk)));
process.on('exit', () => st.kill());

let browser;
try {
    for (let i = 0; ; i += 1) {
        if (await fetch(`http://127.0.0.1:${ST_PORT}/`).then((response) => response.ok, () => false)) break;
        if (st.exitCode !== null || i > 240) throw new Error(`酒馆没有启动：\n${stLog.slice(-20).join('')}`);
        await sleep(500);
    }
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${ST_PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((panel) => globalThis.SillyTavern?.getContext && document.querySelector(panel), PANEL, { timeout: 60000 });
    await sleep(3000);
    // 首次启动会弹提示对话框：Esc 关掉（等于取消，不确认任何东西）。
    const dismissPopups = async () => {
        for (let i = 0; i < 6 && await page.locator('dialog.popup[open]').count(); i += 1) {
            await page.keyboard.press('Escape');
            await sleep(600);
        }
    };
    const status = () => page.locator(`${PANEL} [role="status"]`).textContent();
    const send = async (text) => {
        await dismissPopups();
        const seen = requests.length;
        await page.fill('#send_textarea', text);
        await page.click('#send_but');
        const body = await waitRequest(seen);
        await page.waitForFunction(() => !SillyTavern.getContext().chat.at(-1).is_user, null, { timeout: 20000 });
        return body;
    };

    await dismissPopups();
    await page.evaluate(() => document.querySelector('#api_button_openai').click());
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 20000 });

    // 1. 正常发送：占位句替换原话，工具对紧挨着模型回合，原话只出现在工具结果里。
    const input = '测试一下输入混淆，这是真实输入';
    let body = await send(input);
    const placeholder = body.messages.find((m) => m.role === 'user' && String(m.content).includes('read_user_input'));
    assert.ok(placeholder && !String(placeholder.content).includes(input), '占位句应替换掉原话');
    assert.ok(Array.isArray(body.messages.at(-2)?.tool_calls) && body.messages.at(-1)?.role === 'tool', '工具对应是最后两条');
    assert.equal(JSON.parse(body.messages.at(-1).content).text, input);
    assert.ok(!body.messages.slice(0, -1).some((m) => String(m.content ?? '').includes(input)), '原话不应出现在工具结果之外');
    assert.match(await status(), /已混淆/);
    console.log('PASS 正常发送：原话只在工具结果里，工具对紧挨着模型回合');

    // 1b. 魔法棒菜单里的快捷开关：关掉后原样发送，再打开恢复。
    await page.evaluate(() => document.querySelector('#input-obfuscation-wand').click());
    body = await send('开关关掉后的消息');
    assert.equal(hasToolPair(body.messages), false);
    assert.match(await status(), /已关闭/);
    await page.evaluate(() => document.querySelector('#input-obfuscation-wand').click());
    body = await send('开关打开后的消息');
    assert.equal(hasToolPair(body.messages), true);
    console.log('PASS 魔法棒菜单的开关：关掉原样发送，打开恢复混淆');

    // 2. 后处理选了不带工具的档位：跳过，弹窗提醒。
    await page.evaluate(() => { SillyTavern.getContext().chatCompletionSettings.custom_prompt_post_processing = 'merge'; });
    body = await send('第二条消息');
    assert.equal(hasToolPair(body.messages), false);
    await sleep(500);
    assert.match((await page.locator('.toast-warning .toast-message').allTextContents()).join('\n'), /Post-Processing/);
    assert.match(await status(), /Post-Processing/);
    await page.evaluate(() => { SillyTavern.getContext().chatCompletionSettings.custom_prompt_post_processing = ''; });
    console.log('PASS 不带工具的后处理档位：跳过并弹窗');

    // 3. 后台请求（/gen）：不改写。
    const seen = requests.length;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/gen 后台请求测试'));
    body = await waitRequest(seen);
    assert.equal(hasToolPair(body.messages), false);
    console.log('PASS 后台请求不改写');

    assert.deepEqual(errors, []);
    console.log('PASS 页面无报错');

    // 留一张魔法棒菜单的截图看样式（失败不算）。
    try {
        await dismissPopups();
        await page.click('#extensionsMenuButton');
        await page.waitForSelector('#extensionsMenu', { state: 'visible', timeout: 5000 });
        const shot = process.env.E2E_SHOT_DIR || os.tmpdir();
        await page.locator('#extensionsMenu').screenshot({ path: path.join(shot, 'input-obfuscation-wand.png') });
        console.log('截图：', path.join(shot, 'input-obfuscation-wand.png'));
    } catch (error) {
        console.log('截图跳过：', error.message.split('\n')[0]);
    }
} finally {
    await browser?.close();
    st.kill();
    mock.close();
    await sleep(1500);
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 临时目录留着也无妨 */ }
}
