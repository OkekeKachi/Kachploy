import { cwd } from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), '')

  if (mode === 'production' && !env.VITE_API_URL) {
    throw new Error(
      'VITE_API_URL must be set for production builds. ' +
      'Set it in the deployment environment, for example VITE_API_URL=https://your-staging-api.example.com.'
    )
  }

  return {
    plugins: [
      react(),
      tailwindcss()
    ]
  }
})

// import { defineConfig } from 'vite'
// import tailwindcss from '@tailwindcss/vite'
// export default defineConfig({
//   plugins: [
//     tailwindcss(),
//   ],
// })