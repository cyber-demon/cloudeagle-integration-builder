import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/cloudeagle-integration-builder/',
  plugins: [react(), tailwindcss()],
})
