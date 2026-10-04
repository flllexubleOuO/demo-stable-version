# Lingua · Development 0.3.0

Current release: **0.3.0** (third development iteration, 2026-10-04).

This iteration implements the first real-time speech recognition path for the MVP described in the 0.1 development brief. Translation remains available through the existing provider setting.

## 0.3.0 development status

- Completed: `/healthz` reports version and ASR readiness; static serving is restricted to a frontend file allowlist. Microphone capture is routed through an AudioWorklet that genuinely resamples to mono 16 kHz PCM16LE. The browser uses a single-use, short-lived Gemini token minted by the local server, then streams audio over WebSocket to Gemini Live. Interim and final transcript events render in the original-text column, with final latency measured from the last voiced audio frame.
- Requires configuration: select Gemini in Settings and save a Gemini API key. The permanent key stays in local server memory; the browser receives only a short-lived token restricted to the Live model and transcription setup. `gemini-3.5-transcribe-live` is the selected ASR model.
- Not yet verified against a real microphone: no API key is configured in this workspace, so recognition quality and measured latency still require a live run. Audio streams directly from the browser to Gemini using its official ephemeral-token flow; server-side audio relay and durable capture sessions are not implemented.
- Deferred as requested: translation queue and phone audience broadcast.
- Not started: M1 event and materials flow and M3 persistence, recovery, access control, and deployment.

See the pasted MVP development brief (version 0.1, 2026-10-04) for scope and acceptance criteria.

A browser-based demo for real-time speech recognition and translation. Translation requests are sent through the local Node.js service to the model provider selected in Settings.

## Run locally

Requires Node.js 18 or later. No additional npm dependencies are needed.

```sh
node server.js
```

Then open <http://127.0.0.1:4173/>, choose Gemini in Settings, and save a Gemini API key. Click Start speaking and grant microphone access. This version uses Gemini Live transcription over WebSocket; see the [official Live transcription guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) and [ephemeral token guide](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens).

## Diagnostics

Enable diagnostic logging with `?debugSpeech=1`. Logs are written to `logs/diagnostics.jsonl` and may contain recognized speech. The `logs/` directory is excluded by `.gitignore` and is not included in the repository.

## GitHub Actions 部署到 EC2

`.github/workflows/deploy-ec2.yml` 会在 pull request 和推送到 `main` 时检查 JavaScript 语法；只有 `main` 检查通过后才会部署。部署使用 SSH 同步文件、重启 EC2 上的 systemd 服务，并请求 `http://127.0.0.1:4173/healthz` 验证启动。

### EC2 首次配置

在 EC2 上安装 Node.js 18 或更新版本、`rsync`，创建专用部署用户及应用目录。确保该用户可以写入部署目录，并可通过 sudo 无密码执行指定服务的 `systemctl restart`、`systemctl is-active` 和 `systemctl status`。例如为服务名 `lingua` 配置 sudoers：

```sudoers
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart lingua, /usr/bin/systemctl is-active --quiet lingua, /usr/bin/systemctl status lingua --no-pager
```

将 systemd unit 安装为 `/etc/systemd/system/lingua.service`（按实际用户和目录调整）：

```ini
[Unit]
Description=Lingua translation service
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/lingua
ExecStart=/usr/bin/node /opt/lingua/server.js
Restart=on-failure
Environment=PORT=4173

[Install]
WantedBy=multi-user.target
```

创建目录并启用服务：

```sh
sudo mkdir -p /opt/lingua
sudo chown deploy:deploy /opt/lingua
sudo systemctl daemon-reload
sudo systemctl enable lingua
```

Gemini API key 由应用设置保存机制管理；部署时应在服务端配置好 Gemini key 或通过受保护的管理流程设置，不要提交到仓库。麦克风采集要求安全上下文：本地可使用 `localhost`，生产环境应配置 HTTPS。

### GitHub 配置

在仓库 **Settings → Secrets and variables → Actions** 中添加以下 Repository secrets：

| 名称 | 内容 |
| --- | --- |
| `EC2_HOST` | EC2 公网 DNS 名称或 IP |
| `EC2_USER` | 专用 SSH 部署用户名 |
| `EC2_SSH_PRIVATE_KEY` | 对应部署公钥已写入 EC2 `authorized_keys` 的私钥 |
| `EC2_KNOWN_HOSTS` | EC2 SSH 主机公钥记录（从可信渠道核验后提供） |

添加以下 Repository variables：

| 名称 | 内容 |
| --- | --- |
| `EC2_DEPLOY_PATH` | 应用目录，例如 `/opt/lingua` |
| `EC2_SERVICE_NAME` | systemd 服务名，例如 `lingua` |

首次部署只会在推送到 `main` 且检查通过后运行。请确保 Actions runner 能通过 SSH 访问 EC2，且实例的本地健康检查地址为 `127.0.0.1:4173/healthz`。
