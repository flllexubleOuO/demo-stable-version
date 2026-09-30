# Lingua · Stable Demo

浏览器实时语音识别与翻译演示。翻译请求由本机 Node.js 服务转发到设置中选择的模型提供方。

## 本地运行

需要 Node.js 18 或更新版本；项目没有额外 npm 依赖。

```sh
node server.js
```

然后打开 <http://127.0.0.1:4173/>，在 Settings 中配置模型提供方、模型和 API key。语音识别需要支持 Web Speech API 的浏览器。

调试日志通过 `?debugSpeech=1` 开启，并写入 `logs/diagnostics.jsonl`。日志可能包含识别出的语音文本，已由 `.gitignore` 排除，不会进入仓库。
