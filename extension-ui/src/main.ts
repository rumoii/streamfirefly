import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./theme/tokens.css";
import "./theme/base.css";
import "./theme/components.css";
import "./styles.css";

createApp(App).use(createPinia()).mount("#app");
