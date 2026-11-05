import { greeting } from './greeting.ts';

const app = document.querySelector('#app');
if (app !== null) app.textContent = greeting('visitor');
