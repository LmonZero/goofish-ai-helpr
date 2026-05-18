/**
 * 浏览器反检测指纹伪装脚本
 *
 * 在页面加载前注入，伪装 Canvas/WebGL/Audio/Plugins/Screen 等指纹特征
 * 配合 patchright（Playwright 反检测补丁版），形成两层防护：
 *   1. patchright 底层：消除 CDP 自动化特征（navigator.webdriver、Runtime.enable 泄露等）
 *   2. 本脚本注入层：补充指纹伪装（Canvas/WebGL/Audio/Screen/Plugins 等）
 *
 * 使用方式：
 *   context.addInitScript(require('./anti-detect'))  — 上下文级别，所有页面自动生效
 *   page.addInitScript(require('./anti-detect'))      — 页面级别，仅当前页面生效
 */
module.exports = function antiDetectScript() {
    // ===== navigator 属性伪装 =====
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

    // ===== plugins 伪装（完整 PluginArray / Plugin / MimeTypeArray 接口）=====
    // 问题：Object.create(PluginArray.prototype) 创建的对象没有原生内部 slot，
    //       调用 PluginArray.prototype 上的原生方法（如 [Symbol.iterator]）
    //       会抛出 "Illegal invocation"，导致闲鱼等网站的指纹检测脚本崩溃白屏
    // 方案：在实例上覆盖所有原生方法，用纯 JS 实现，不依赖原生内部 slot
    const _plugins = [];
    const _fakePluginData = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    const _def = (obj, prop, desc) => Object.defineProperty(obj, prop, { ...desc, configurable: true, enumerable: true });

    for (const p of _fakePluginData) {
        const plugin = Object.create(Plugin.prototype);
        _def(plugin, 'name', { get: () => p.name });
        _def(plugin, 'filename', { get: () => p.filename });
        _def(plugin, 'description', { get: () => p.description });
        _def(plugin, 'length', { get: () => 0 });
        _def(plugin, 'item', { value: () => null });
        _def(plugin, 'namedItem', { value: () => null });
        _def(plugin, Symbol.iterator, { value: function* () { } });
        _def(plugin, 'forEach', { value: () => { } });
        _def(plugin, '0', { get: () => undefined });
        _plugins.push(plugin);
    }

    const pluginArray = Object.create(PluginArray.prototype);
    _def(pluginArray, 'length', { get: () => _plugins.length });
    _def(pluginArray, 'item', { value: (i) => _plugins[i] ?? null });
    _def(pluginArray, 'namedItem', { value: (name) => _plugins.find(p => p.name === name) || null });
    _def(pluginArray, 'refresh', { value: () => { } });
    _def(pluginArray, Symbol.iterator, { value: function* () { for (const p of _plugins) yield p; } });
    _def(pluginArray, 'entries', { value: function* () { for (let i = 0; i < _plugins.length; i++) yield [i, _plugins[i]]; } });
    _def(pluginArray, 'keys', { value: function* () { for (let i = 0; i < _plugins.length; i++) yield i; } });
    _def(pluginArray, 'values', { value: function* () { for (const p of _plugins) yield p; } });
    _def(pluginArray, 'forEach', { value: (cb) => { _plugins.forEach((p, i) => cb(p, i, pluginArray)); } });
    _def(pluginArray, 'map', { value: (cb) => _plugins.map((p, i) => cb(p, i, pluginArray)) });
    for (let i = 0; i < _plugins.length; i++) {
        _def(pluginArray, i, { get: () => _plugins[i] });
    }

    // MimeTypeArray 也需要完整接口
    const mimeTypeArray = Object.create(MimeTypeArray.prototype);
    _def(mimeTypeArray, 'length', { get: () => 0 });
    _def(mimeTypeArray, 'item', { value: () => null });
    _def(mimeTypeArray, 'namedItem', { value: () => null });
    _def(mimeTypeArray, 'refresh', { value: () => { } });
    _def(mimeTypeArray, Symbol.iterator, { value: function* () { } });
    _def(mimeTypeArray, 'forEach', { value: () => { } });

    Object.defineProperties(navigator, {
        plugins: { get: () => pluginArray, configurable: true },
        mimeTypes: { get: () => mimeTypeArray, configurable: true },
    });

    // ===== Chrome 运行时伪装 =====
    // 注意：loadTimes/csi 在 Chrome 71+ 已弃用，新浏览器中不存在这些 API
    // 只有在页面本身访问时才注入，避免"不该有的反而有"的检测
    if (!window.chrome) {
        window.chrome = {};
    }
    if (!window.chrome.runtime) {
        window.chrome.runtime = { connect: function () { }, sendMessage: function () { } };
    }
    if (!window.chrome.app) {
        window.chrome.app = { isInstalled: false };
    }

    // ===== Permissions API 伪装 =====
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery.call(window.navigator.permissions, parameters)
        );
    }

    // ===== WebGL 渲染器伪装（避免 Headless 特征）=====
    const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
        // UNMASKED_VENDOR_WEBGL
        if (param === 37445) return 'Google Inc. (NVIDIA)';
        // UNMASKED_RENDERER_WEBGL
        if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterOrig.call(this, param);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2Orig = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return 'Google Inc. (NVIDIA)';
            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter2Orig.call(this, param);
        };
    }

    // ===== Canvas 指纹加噪（toDataURL + toBlob 保持一致）=====
    const _canvasNoise = (ctx, w, h) => {
        try {
            const imgData = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < imgData.data.length; i += 4 * 37) {
                imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + (Math.random() > 0.5 ? 1 : -1)));
            }
            ctx.putImageData(imgData, 0, 0);
        } catch (_) { }
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
        if (this.width === 0 || this.height === 0) return origToDataURL.apply(this, arguments);
        const ctx = this.getContext('2d');
        if (ctx) _canvasNoise(ctx, this.width, this.height);
        return origToDataURL.apply(this, arguments);
    };
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function () {
        if (this.width === 0 || this.height === 0) return origToBlob.apply(this, arguments);
        const ctx = this.getContext('2d');
        if (ctx) _canvasNoise(ctx, this.width, this.height);
        return origToBlob.apply(this, arguments);
    };

    // ===== iframe contentWindow 检测修补 =====
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function () {
            const result = origContentWindow?.get?.call(this);
            if (result) {
                try { result.navigator; } catch (e) { return null; }
            }
            return result;
        },
        configurable: true,
    });

    // ===== 屏幕与窗口属性（修复 headless 特征）=====
    if (screen.width === 0 || screen.height === 0) {
        Object.defineProperties(screen, {
            width: { get: () => 1920, configurable: true },
            height: { get: () => 1080, configurable: true },
            availWidth: { get: () => 1920, configurable: true },
            availHeight: { get: () => 1040, configurable: true },
            colorDepth: { get: () => 24, configurable: true },
            pixelDepth: { get: () => 24, configurable: true },
        });
    }

    // ===== 外部窗口尺寸修正 =====
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
    }
    if (window.outerHeight === 0) {
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });
    }

    // ===== AudioContext 指纹加噪 =====
    const audioCtx = window.AudioContext || window.webkitAudioContext;
    if (audioCtx) {
        const origGetFloatFreqData = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = function (array) {
            origGetFloatFreqData.call(this, array);
            for (let i = 0; i < array.length; i++) {
                array[i] = array[i] + (Math.random() - 0.5) * 0.001;
            }
        };
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function (channel) {
            const data = origGetChannelData.call(this, channel);
            for (let i = 0; i < data.length; i += 100) {
                data[i] = data[i] + (Math.random() - 0.5) * 0.0001;
            }
            return data;
        };
    }

    // ===== navigator.connection 伪装 =====
    if (!navigator.connection) {
        Object.defineProperty(navigator, 'connection', {
            get: () => ({
                effectiveType: '4g',
                rtt: 50,
                downlink: 10,
                saveData: false,
                onchange: null,
                type: 'wifi',
            }),
            configurable: true,
        });
    }

    // ===== navigator.getBattery 伪装（避免 headless 无 battery API 暴露）=====
    if (!navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1,
            addEventListener: function () { },
            removeEventListener: function () { },
            dispatchEvent: function () { return true; },
        });
    }

    // ===== 阻止 toString 检测（检查函数是否被修改过）=====
    const _origToString = Function.prototype.toString;
    const _patchedFns = new WeakSet();
    const _markPatched = (fn) => { _patchedFns.add(fn); return fn; };
    Function.prototype.toString = function () {
        return _patchedFns.has(this) ? `function ${this.name || ''}() { [native code] }` : _origToString.call(this);
    };
    // 将所有伪装的函数标记
    _markPatched(WebGLRenderingContext.prototype.getParameter);
    _markPatched(HTMLCanvasElement.prototype.toDataURL);
    _markPatched(HTMLCanvasElement.prototype.toBlob);
    if (window.AudioContext || window.webkitAudioContext) {
        _markPatched(AnalyserNode.prototype.getFloatFrequencyData);
        _markPatched(AudioBuffer.prototype.getChannelData);
    }
    _markPatched(Function.prototype.toString);
};
