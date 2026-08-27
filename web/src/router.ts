import { createRouter, createWebHistory } from 'vue-router'
import AppInner from './components/AppInner.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: AppInner,
      children: [
        { path: '', redirect: '/library' },
        {
          path: 'library',
          name: 'library',
          component: () => import('./components/LibraryPanel.vue'),
        },
        {
          path: 'favorites',
          name: 'favorites',
          component: () => import('./components/LibraryPanel.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('./components/SettingsView.vue'),
        },
        {
          path: 'series/:id',
          name: 'series',
          component: () => import('./components/DetailPanel.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/library' },
  ],
})
