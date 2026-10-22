import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Quasar, Dark, Dialog, Notify } from 'quasar'
import quasarLangEs from 'quasar/lang/es'
import router from './router'
import App from './App.vue'

import '@quasar/extras/material-icons/material-icons.css'
import '@quasar/extras/material-symbols-outlined/material-symbols-outlined.css'
import 'quasar/src/css/index.sass'
import './css/acrobat.scss'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(Quasar, {
  plugins: { Dark, Dialog, Notify },
  // The shell is Acrobat's Spanish one: without the pack every dialog asked
  // with `cancel: true` offered "Cancel" and "OK" (the sticky note's among
  // them). "Aceptar", not the pack's "OK", as the shell's own dialogs say.
  lang: { ...quasarLangEs, label: { ...quasarLangEs.label, ok: 'Aceptar' } },
  config: {
    dark: false,
    // Acrobat's blue for every Quasar control that asks for the primary colour.
    brand: { primary: '#2680eb', secondary: '#4b9cf5', accent: '#f56bb7', dark: '#323232' }
  }
})

app.mount('#app')
