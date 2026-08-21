# Local Fun-ASR-Nano Service

This process keeps the Fun-ASR-Nano model and native OpenASR runtime outside Electron.

## First-time setup

1. Install OpenASR and pull the model pack:

```powershell
openasr pull funasr-nano:q8
```

Use `funasr-nano:q4` on a lower-memory machine. The OpenASR model page lists q8 as the default pack and q4 as the smaller quantization.

2. Create the Python environment once. The desktop app will start the services automatically after setup:

```powershell
cd apps/local-asr-service
python -m venv .venv
.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt
```

3. Select `Local Fun-ASR-Nano` in the desktop settings and click “测试连接” or “开始面试”. Electron Main automatically starts both `openasr serve` and the Python WebSocket facade with hidden child processes, waits for the ports to become ready, and stops only the processes it started when the app exits. No service windows need to be opened manually.

The Electron setting is `ws://127.0.0.1:8765`. The facade accepts binary PCM16, 16 kHz, mono frames and returns `asr_partial` / `asr_final` JSON messages. Its boundary VAD drops silence before sending audio to OpenASR.

For development diagnostics, the facade can still be started manually:

```powershell
.\\.venv\\Scripts\\python.exe server.py --model funasr-nano:q8 --port 8765
```

To use another OpenASR bind address:

```powershell
python server.py --upstream http://127.0.0.1:8080
```

The model is never loaded into Electron. The installer includes the WebSocket facade source, but the OpenASR runtime and model remain external because of their size; install OpenASR and pull the model once on each target machine. A backend outage is reported as a local ASR connection/runtime error and does not change the existing Deepgram or Custom Gateway paths.
