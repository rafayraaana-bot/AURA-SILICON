# AURA SILICON engineering preview

This repository is an early, incomplete implementation. It is not a production SoC compiler or physical-design platform.

## Implemented path

The runnable path currently supports:

1. Email/password sign-up and sign-in with expiring, revocable bearer sessions.
2. Organization-scoped project creation and source file editing.
3. Immutable project versions containing source snapshots, compiler/technology configuration, and a SHA-256 content hash.
4. An asynchronous in-process compile job for a deliberately small RTL subset:
   - module declarations and `endmodule`
   - ANSI-style module ports
   - `input`, `output`, `inout`, `wire`, `reg`, and `logic` declarations
   - simple continuous assignments
   - line and block comments
5. Source-located diagnostics for malformed or unsupported input.
6. Deterministically hashed AURA IR JSON artifacts in content-addressed local storage, with organization-scoped download authorization.
7. A browser editor that saves, versions, compiles, polls job state, displays diagnostics, and downloads the generated IR.
8. Browser-native folder selection, recursive project-tree grouping, Verilog/SystemVerilog module and best-effort dependency inspection, testbench/constraint/library/configuration/IP detection, and server-side rescan/import preview.
9. A copied, organization-scoped AURA project workspace. Rescans require explicit confirmation, replace only the mutable AURA copy, and retain immutable versions. Sensitive and unsupported files are excluded and reported; selected local files are never written to.
10. Top-module selection and a persisted project design brief, plus opt-in DeepSeek/Groq RTL analysis, AI-generated project testbenches, and compiler-error auto-repair when a provider is configured. Testbench generation writes one validated, separate testbench file for the user to review and explicitly run. Auto-repair requires separate explicit consent, changes one source file only, and applies it only after AURA RTL compiler validation; it makes one bounded attempt and does not run physical-design tools.
11. A real-artifact-gated cross-platform download page. It enables an installer only when the matching Windows `.exe`, macOS `.dmg`, or Linux `.AppImage` exists locally or has a configured HTTPS release URL; no placeholder installer is served.
12. An Electron desktop foundation with a sandboxed renderer, isolated IPC bridge, native folder picker, bounded read-only project scan, monitored source-folder changes, confirmed export to a new folder, and Windows-secure session-token storage. It uses the same AURA HTTP API and project identity as the web application.
13. Backend-served FREE, Professional ($1,500/month), and Ultra Enterprise ($100,000/month) plan configuration, USD base pricing, USD-to-PKR display conversion, plan usage meters, and server-side project/compiler/storage limits. Professional includes 70 AI hardware requests per month; FREE has restricted synthesis/physical-design access; Ultra enables all currently implemented capabilities.
14. A checkout review flow that uses backend-calculated plan amounts but does not create subscriptions or collect payment while no payment provider is configured.
15. An opt-in, local-only OpenLane 2 + SKY130 physical-design job from the workspace. The job stages an immutable RTL snapshot, requires explicit execution consent, and records downloadable GDSII/netlist artifacts only after the real run produces and verifies them.
16. A compiled RTL dataflow graph drawn from the successful AURA IR artifact, with an optional AI explanation that requires explicit source-sharing consent. It represents compiler-visible signals and continuous assignments, not a synthesized gate-level netlist or physical layout.
17. An authenticated physical-layout viewer for completed OpenLane runs that produce verified GDSII for RTL. KLayout extracts the real GDSII polygons; Three.js displays those X/Y shapes as an orbitable exploded 3D layer view and a 2D top-down view, with per-layer controls and artifact downloads. Z spacing is expanded for visibility, not claimed as fabricated layer thickness. A separately labeled, optional i7-1165G7-inspired educational floorplan is illustrative only; it is not Intel design data, GDSII, or a physical-design result.
18. Separate synthesizable five-stage RV32I processor examples: a single core and an eight-core wrapper with independent instruction/data ports per core. Self-checking WSL scripts run Icarus, Verilator, and Yosys. The eight-core RTL can be imported and physically designed through the consent-gated local OpenLane flow; no shared-memory coherence, Intel implementation, fabricated chip, or foundry signoff is claimed.

Open the physical-layout viewer at `/visualizer`. Verified results appear only after a completed RTL-backed OpenLane run produces GDSII. The optional i7-inspired concept can be opened at `/visualizer?concept=i7`; it is clearly identified as an illustration and never substitutes for a physical-design result or provides Intel artifacts. In the workspace, explicitly opt in to run OpenLane automatically after AI-generated RTL passes its Icarus testbench; verified layout results appear only after the physical run completes.

Procedural blocks, preprocessing, broad SystemVerilog support, AURA-native synthesis/netlist optimization, congestion analysis, physical signoff validation, and physically accurate GDSII Z-stack reconstruction are not implemented in the AURA web application. Completed local OpenLane runs include authenticated 3D exploded-layer and 2D top-down views extracted from verified GDSII by KLayout; the 3D Z spacing is illustrative, and neither view is a congestion/signoff report. The optional i7-1165G7-inspired floorplan is an educational illustration, not an Intel-derived or physically verified layout. Local Icarus Verilog simulation is available for trusted Verilog/SystemVerilog testbenches. GitHub OAuth is implemented; the configured client ID is present locally, but sign-in remains unavailable until the matching app client secret is configured in the local server environment. The Electron desktop client has release targets for Windows x64, universal macOS (Intel + Apple silicon), and Linux x64 AppImage. The download page enables each platform only when its release is configured. The desktop client requires the HTTPS AURA API server URL (not merely a static website URL); the desktop binary is a client, not a bundled backend. Its update mechanism requires a configured HTTPS generic release feed. Linux secure session storage requires a supported system keyring/secret service. The current OpenLane physical-design executor is Windows + WSL 2 only; macOS/Linux desktop clients can use the shared API for supported features but do not provide a native OpenLane runner. Physical-design results appear only after a real OpenLane run produces verified final GDSII and synthesized-netlist artifacts.

For WSL/OpenLane prerequisites and the included AND-gate physical-design example, see [OpenLane 2 on WSL](docs/physical-design-wsl.md). The workspace can launch local physical-design jobs when WSL 2, OpenLane 2, and SKY130 are installed. Completed GDSII is downloadable and displayed as an exploded 3D layer view and 2D top-down physical layout extracted from the verified artifact.

Folder scanning runs in the browser and uploads only eligible text files selected by the user. Import limits are 250 files, 512 KiB per file, and 8 MiB total text content. `.git`, dependency, and common build-output directories are skipped; credential-like files and binary/unsupported formats are reported but not copied. Top-module and dependency detection is a source-text heuristic, not a full HDL elaborator. VHDL is retained as context only and cannot be compiled.

## Run locally

```powershell
npm install
$env:JWT_SECRET = "use-a-private-random-development-secret"
npm start
```

Open the exact `http://localhost:<port>` address printed by startup. If the default port is already occupied, the development server checks the next ports through 3100 instead of silently serving through an unrelated process. Create an account, select a project, edit `top.sv`, and choose **Create Version & Compile**.

## Run with Docker Desktop

Docker Desktop's Linux engine is required. From the project root, run:

```powershell
docker compose up --build -d
docker compose ps
```

The Compose service binds its API to loopback port 3001 and persists its data
in the `aura-data` Docker volume. Its browser pages redirect to the canonical
native Windows app at `http://localhost:3000`, keeping the website, login, and
workspace on one origin; the native server is required for Windows WSL
OpenLane jobs. Open `http://localhost:3000` for the application. A local `.env`
file, if present, is passed to the container for optional AI/OAuth configuration;
never put secrets in the image or commit them. To stop the container, run
`docker compose down`.

After **Create Version & Compile** succeeds, the workspace loads that version's
AURA IR artifact and draws its signal/assignment dependency graph. **Ask AI to
Explain Graph** sends the graph summary and project RTL only after the
source-sharing consent is checked and an AI provider is configured. The
response is an explanation, not compiler output or hardware validation.

## GitHub sign-in

Register a GitHub OAuth App with the callback URL `https://<your-public-domain>/api/v1/auth/github/callback`. Configure these values only in the API server's protected environment or secret manager:

```text
AURA_GITHUB_CLIENT_ID
AURA_GITHUB_CLIENT_SECRET
AURA_PUBLIC_URL=https://<your-public-domain>
```

Restart the API server after setting them. GitHub sign-in is enabled only when all three settings are valid. The app requests `read:user user:email`, requires GitHub's verified primary email, creates or links the AURA account by that verified email, and issues the same revocable AURA session as password sign-in. Never commit OAuth secrets or put them in browser code. If a client secret was pasted into chat, revoke it and generate a replacement before configuring the server. For local testing, use a GitHub OAuth App configured with the exact local callback URL and set `AURA_PUBLIC_URL` to that same localhost origin.

For local development, copy `.env.example` to `.env`, replace the placeholders with your new OAuth app values, and set `AURA_PUBLIC_URL=http://localhost:3001` if that is the port the server prints. `.env` is git-ignored and is loaded by the API on startup. Register the matching callback URL `http://localhost:3001/api/v1/auth/github/callback` in GitHub. Never paste the replacement secret into chat or commit `.env`.

## Google sign-in

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `AURA_PUBLIC_URL` only in the private API-server environment. Add the exact authorized redirect URI `${AURA_PUBLIC_URL}/api/v1/auth/google/callback` to the Google OAuth client. Google sign-in uses OAuth state validation, requires a verified Google email, links accounts by that verified email, and keeps the client secret server-side. Never put OAuth secrets in public frontend files or commit `.env`; rotate any secret that has been shared outside the private server configuration.

## AI hardware analysis

The server supports DeepSeek and Groq through their OpenAI-compatible chat completion APIs. Put newly rotated keys in the ignored local `.env` file as `DEEPSEEK_API_KEY` and/or `GROQ_API_KEY`, and set `AURA_AI_PROVIDER=deepseek` or `AURA_AI_PROVIDER=groq`. The server never returns or logs provider keys. If both providers are configured, an explicit provider selection is required. Restart the server after changing `.env`; `GET /api/v1/ai/status` reports only the provider/model and whether configuration is ready.

Authenticated requests to `POST /api/v1/projects/:projectId/ai/requests` require explicit source-sharing consent. Only selected Verilog/SystemVerilog source is sent (up to 30 files, 100 KiB per file and 250 KiB total); analysis returns suggestions only. `POST /api/v1/projects/:projectId/ai/testbenches` uses that same explicit consent to ask the provider to write and save a separate testbench under `tb/`; the response is checked for a safe path and module, but it is not run automatically. Review generated HDL, then explicitly authorize local simulation. The compiler-error auto-fix flow additionally requires the workspace's separate consent toggle and a failed AURA compile job. It sends that version's eligible RTL and diagnostics to the configured provider, permits one repair of the diagnosed file, and writes nothing unless the candidate passes AURA's RTL-subset compiler. It does not prove functional correctness; review the change and run a trusted testbench. AI usage is metered against the organization plan. Default AI limits are 20 monthly requests for FREE, 70 for Professional, and 2,000 for Ultra Enterprise. The workspace enables AI only after a provider key is configured. Do not use this feature for confidential RTL unless your organization approves sending that source to the chosen provider.

For a complete plain-language hardware request, `POST /api/v1/projects/:projectId/ai/designs` generates a fresh project containing synthesizable `top.sv` and a self-checking `tb/<module>_tb.sv`. It requires both source-sharing consent and explicit consent to execute generated HDL locally. AURA checks the testbench/DUT relationship, compiles and runs the candidate using Icarus in an isolated temporary directory, and requires a per-test PASS plus the final `AURA_ALL_TESTS_PASS` marker. On compiler or assertion failures it can request up to two AI repairs; failed candidates are never saved. After a verified pass, RTL, testbench and the original request are saved as a new project. Simulation is functional evidence from that testbench, not formal verification or synthesis. This complete project-generation flow requires both a configured AI provider and working Icarus binaries.

## PKR price display

Plan base prices are USD. When an administrator has not set a fixed `usdToPkrRate`, the pricing API fetches the USD/PKR reference rate from ExchangeRate-API and caches it for 12 hours. The pricing response identifies the source and rate timestamp; PKR remains an indicative display conversion, not a payment quote. If the provider is unreachable and no administrator rate has been set, the UI reports the exchange-rate issue and retains USD pricing. Checkout remains preview-only until a real payment provider is configured.

## Local Verilog simulation

The workspace runs trusted Verilog/SystemVerilog testbenches through Icarus Verilog. On Windows it detects `C:\iverilog\bin\iverilog.exe` and `vvp.exe`; elsewhere set `AURA_IVERILOG_PATH` and `AURA_VVP_PATH`. Simulation requires a testbench under a `tb`/`testbench`/`tests` path or with a `_tb`/`_testbench` name. Select a testbench, explicitly approve local execution, and only run source you trust. Testbench files are excluded from AURA IR compilation and included in Icarus simulation. Execution is limited to loopback clients, copied to a fresh temporary directory, limited to 20 seconds compilation / 10 seconds runtime / 1 MiB output, and the temporary workspace is removed afterward. Common HDL system/file-access tasks are rejected. Results are testbench output only—not synthesis, place-and-route, or GDSII. Default configurable monthly limits are 20 / 500 / 2,000 for FREE / Professional / Ultra Enterprise.

## Desktop development

The native Windows shell is in `desktop/`. It is not a standalone design engine: it connects to the same AURA service as the web app. Start that service first, then:

```powershell
cd desktop
npm install
$env:AURA_WEB_URL = "http://localhost:3000"
npm start
```

The shell uses a native directory chooser and a bounded, read-only scan; importing creates a separate AURA copy. Export requires an explicit confirmation and writes a new project folder. The renderer has no Node.js access, and session tokens are encrypted with the Windows OS-backed Electron `safeStorage` API. The packaged updater verifies update metadata and package hashes using `electron-updater`; it remains unavailable until an HTTPS feed and release metadata exist.

Build desktop packages from `desktop/` on a native runner for each operating system:

```powershell
npm run dist:win    # Windows x64 NSIS installer
npm run dist:mac    # universal macOS DMG for Intel and Apple silicon (build on macOS)
npm run dist:linux  # Linux x64 AppImage
```

Desktop builds embed `AURA_DESKTOP_DEFAULT_SERVER_URL` or `AURA_PUBLIC_URL`. A healthy configured API opens the sign-in page directly; after sign-in, the app opens the workspace. The GitHub release workflow requires the repository variable `AURA_PUBLIC_URL` to point to the deployed AURA API.

The `.github/workflows/desktop-release.yml` workflow builds on native Windows, macOS, and Linux GitHub-hosted runners when a matching `desktop-v<version>` tag is pushed. Before tagging, set the version in `desktop/package.json`. Configure repository Actions secrets `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` for the Windows PFX; configure `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for signed and notarized macOS releases. The release job publishes installers plus `SHA256SUMS.txt` to a GitHub Release; unsigned Windows/macOS packages are rejected by the workflow. Linux AppImage checksums are included. After the GitHub repository exists and a signed release has been published, set `AURA_DESKTOP_GITHUB_REPOSITORY=owner/repository` and `AURA_DESKTOP_VERSION` on the AURA API server; the download page then links directly to the matching HTTPS GitHub release assets. Alternatively, configure per-platform public HTTPS overrides `AURA_WINDOWS_DOWNLOAD_URL`, `AURA_MACOS_DOWNLOAD_URL`, and `AURA_LINUX_DOWNLOAD_URL`. A configured link is not a substitute for having published the matching asset. For local or self-hosted previews, macOS and Linux artifacts built with the documented names in `desktop/release/` are detected automatically; otherwise, the per-platform `AURA_*_INSTALLER_PATH` values can point to existing files. The API validates file types and serves actual files, including range requests. Local previews are not signed/notarized, so operating systems may warn or require explicit user approval. No GitHub repository is connected to this local workspace yet, so cloud publishing must be enabled in the repository where this code is hosted. The desktop application still needs an already deployed HTTPS AURA API server to be useful after installation.

Authentication endpoints limit sign-up attempts to 5 per network address per hour and unsuccessful sign-in attempts to 10 per 15 minutes. Successful sign-ins do not count toward the failed-login limit. Limits use the default in-memory store and therefore reset when the server restarts; multi-instance production deployments need a shared rate-limit store. If deployed behind a trusted reverse proxy, configure `AURA_TRUST_PROXY_HOPS` to the exact number of proxy hops so client-address limits work without trusting spoofed forwarding headers.

For production, `JWT_SECRET` is mandatory. The current JSON-file store and in-process worker are for local development only; they do not provide multi-process transactional safety, sandboxing, or production durability.

## Pricing and administrator configuration

Plan prices, limits and feature flags are stored in `AURA_DATA_DIR/billing-config.json` and are served dynamically; changing the file or using the authenticated admin API does not require rebuilding the web application. Monthly base prices are $0 FREE, $1,500 Professional, and $100,000 Ultra Enterprise. The USD/PKR toggle converts those USD prices using the current exchange-rate service; PKR is indicative, not a payment quote. Initial limits are 10 projects, 100 compiler jobs, 20 AI requests, 20 simulations, and 5 GiB storage for FREE; 100 projects, 1,000 compiler jobs, 70 AI requests, 500 simulations, and 50 GiB storage for Professional; and 500 projects, 5,000 compiler jobs, 2,000 AI requests, 2,000 simulations, and 500 GiB storage for Ultra Enterprise. FREE does not include synthesis, netlist inspection, physical-design jobs, or GDSII. Pro and Ultra include all currently implemented capabilities, but unimplemented team, priority, architecture-generation, and WebGPU functions remain unavailable. AI requires a configured provider. Simulation quota is enforced when Icarus Verilog is available.

Set `AURA_ADMIN_EMAIL` on the API server to the exact account authorized to read/update `/api/v1/admin/pricing`. The admin `PUT` accepts the complete validated config. `usdToPkrRate` starts unset and must be supplied by an administrator; subscription prices remain USD base prices. The current billing endpoints are `GET /api/v1/pricing`, `GET /api/v1/usage`, `GET /api/v1/billing`, and `POST /api/v1/billing/checkout-preview`. `POST /api/v1/billing/checkout` returns `503` until a real payment provider is implemented and configured. No frontend-supplied price is trusted and no checkout preview creates a subscription.

## API

Authenticated endpoints use `Authorization: Bearer <token>`.

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `GET|POST /api/v1/projects`
- `POST /api/v1/projects/import/scan` (preview only)
- `POST /api/v1/projects/import`
- `POST /api/v1/projects/:projectId/rescan`
- `GET /api/v1/projects/:projectId/import-analysis`
- `PUT /api/v1/projects/:projectId/top-module`
- `GET|PUT /api/v1/projects/:projectId/design-brief` (records intent only; does not execute it)
- `PUT /api/v1/projects/:projectId/files`
- `POST /api/v1/projects/:projectId/versions`
- `GET /api/v1/project-versions?projectId=:id`
- `POST /api/v1/compiler/compile` with `projectId`, immutable `versionId`, and `title`
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/artifacts`
- `GET /api/v1/artifacts/:artifactId/download`

Errors use `{ error: { code, message, requestId, details } }`. GitHub OAuth routes are `/api/v1/auth/github` and `/api/v1/auth/github/callback`; `GET /api/v1/auth/providers` reports whether the GitHub provider is configured. SAML/Stripe/physical-design endpoints are not represented as functional services.

## Tests

```powershell
npm test
```
