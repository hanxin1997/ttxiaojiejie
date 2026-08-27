import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/global.css'
import './styles/material-ripple.css'

const app = createApp(App)
app.use(router)

app.config.errorHandler = (err, _instance, info) => {
  console.error(`[Vue Error] ${info}:`, err)
}

app.mount('#app')
