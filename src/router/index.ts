import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('../layouts/EditorLayout.vue'),
      children: [
        { path: '', component: () => import('../pages/EditorPage.vue') }
      ]
    }
  ]
})

export default router
