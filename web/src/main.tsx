import './polyfills.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
// OreUI（我的世界）主题的控件样式：上游 Spectrollay-OreUI 的原始样式表
import './oreui/oreui.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
