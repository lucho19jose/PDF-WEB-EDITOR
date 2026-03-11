import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Quasar, Dark } from 'quasar'
import router from './router'
import App from './App.vue'

import '@quasar/extras/material-icons/material-icons.css'
import 'quasar/src/css/index.sass'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(Quasar, {
  plugins: { Dark },
  config: {
    dark: true
  }
})

app.mount('#app')
