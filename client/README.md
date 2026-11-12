# KachPloy client

React + Vite single-page application. See the root `README.md` for deployment and staging instructions.

## Local development

```bash
npm ci
npm run dev
```

The API base URL comes from `VITE_API_URL`. When it is unset, local development falls back to `http://localhost:3000`.

## Checks

```bash
npm test
npm run lint
```

## Production build

```bash
VITE_API_URL=https://<staging-backend-host> npm run build
```

`VITE_API_URL` is required for production builds. The build fails when it is missing. The value is inlined by Vite, so changing the backend origin requires a rebuild.

Copy `client/.env.example` when creating a local `.env`. It contains placeholders only; never commit real credentials.
