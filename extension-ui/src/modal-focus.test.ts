import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { vModalFocus } from "./modal-focus";

const fixture = defineComponent({
  directives: { modalFocus: vModalFocus },
  setup() { const open = ref(false); return { open, close: () => { open.value = false; } }; },
  template: `<div><button @click="open = true">open</button><div v-if="open" role="dialog" v-modal-focus="close"><button>first</button><button>middle</button><button>last</button></div></div>`
});

it.each(["open", "closed"] as const)("keeps modal keyboard navigation and restores focus in %s shadow", async mode => {
  const host = document.createElement("div"); document.body.append(host);
  const root = host.attachShadow({ mode });
  const container = document.createElement("div"); root.append(container);
  const wrapper = mount(fixture, { attachTo: container });
  try {
    const opener = wrapper.get("button").element as HTMLElement; opener.focus();
    await wrapper.get("button").trigger("click"); await flushPromises();
    const buttons = wrapper.findAll('[role="dialog"] button').map(button => button.element as HTMLElement);
    expect(root.activeElement).toBe(buttons[0]);
    buttons[1].focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true });
    buttons[1].dispatchEvent(tab); expect(tab.defaultPrevented).toBe(false);
    buttons[2].focus(); buttons[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true }));
    expect(root.activeElement).toBe(buttons[0]);
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await flushPromises(); expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(root.activeElement).toBe(opener);
  } finally { wrapper.unmount(); host.remove(); }
});
