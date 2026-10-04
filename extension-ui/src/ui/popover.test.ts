import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import SfMenu from "./SfMenu.vue";
import SfPopover from "./SfPopover.vue";
import SfSelect from "./SfSelect.vue";

const fixture = defineComponent({
  components: { SfMenu, SfPopover, SfSelect },
  template: `<div>
    <input aria-label="网页输入框">
    <SfPopover label="筛选" icon="adjustments-horizontal">
      <input aria-label="最小大小"><input aria-label="最大大小">
      <SfSelect model-value="detected" :options="[{ value: 'detected', label: '嗅探顺序' }, { value: 'size', label: '文件大小' }]" label="排序方式" />
      <SfMenu label="更多操作" :items="[{ key: 'copy', label: '复制' }, { key: 'remove', label: '移除' }]" />
    </SfPopover>
  </div>`
});

function key(element: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, composed: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe.each([false, true])("popover keyboard ownership (shadow=%s)", shadow => {
  let host: HTMLElement;
  let root: Document | ShadowRoot;
  let wrapper: VueWrapper;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = shadow ? host.attachShadow({ mode: "open" }) : document;
    const container = document.createElement("div");
    (shadow ? root : host).appendChild(container);
    wrapper = mount(fixture, { attachTo: container });
  });
  afterEach(() => { wrapper.unmount(); host.remove(); });

  it("keeps the filter open for Tab between fields and closes when focus leaves", async () => {
    await wrapper.get('[aria-label="筛选"]').trigger("click");
    await flushPromises();
    const minimum = wrapper.get('[aria-label="最小大小"]').element as HTMLElement;
    const maximum = wrapper.get('[aria-label="最大大小"]').element as HTMLElement;
    expect(root.activeElement).toBe(minimum);
    expect(key(minimum, "Tab").defaultPrevented).toBe(false);
    await flushPromises();
    expect(wrapper.find('[data-sf-popover]').exists()).toBe(true);
    maximum.focus();
    await flushPromises();
    expect(wrapper.find('[data-sf-popover]').exists()).toBe(true);
    (wrapper.get('[aria-label="网页输入框"]').element as HTMLElement).focus();
    await flushPromises();
    expect(wrapper.find('[data-sf-popover]').exists()).toBe(false);
  });

  it("closes only the nested select on Escape and returns focus to its trigger", async () => {
    await wrapper.get('[aria-label="筛选"]').trigger("click");
    await flushPromises();
    await wrapper.get('[aria-label="排序方式"]').trigger("click");
    await flushPromises();
    const select = wrapper.get('[role="listbox"]').element;
    expect(key(select, "ArrowDown").defaultPrevented).toBe(true);
    await flushPromises();
    expect(wrapper.get('[role="option"].active').text()).toBe("文件大小");
    expect(key(select, "Escape").defaultPrevented).toBe(true);
    await flushPromises();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.find('[role="group"][data-sf-popover]').exists()).toBe(true);
    const trigger = wrapper.get('[aria-label="排序方式"]').element;
    expect(root.activeElement).toBe(trigger);
    key(trigger, "Escape");
    await flushPromises();
    expect(wrapper.find('[data-sf-popover]').exists()).toBe(false);
    expect(root.activeElement).toBe(wrapper.get('[aria-label="筛选"]').element);
  });

  it("leaves webpage keyboard events unhandled after focus moves outside", async () => {
    await wrapper.get('[aria-label="筛选"]').trigger("click");
    await flushPromises();
    await wrapper.get('[aria-label="排序方式"]').trigger("click");
    await flushPromises();
    const input = wrapper.get('[aria-label="网页输入框"]').element as HTMLElement;
    input.focus();
    const received: string[] = [];
    input.addEventListener("keydown", event => received.push(event.key));
    expect(key(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(key(input, "Escape").defaultPrevented).toBe(false);
    await flushPromises();
    expect(received).toEqual(["ArrowDown", "Escape"]);
    expect(wrapper.find('[data-sf-popover]').exists()).toBe(false);
    expect(root.activeElement).toBe(input);
  });

  it("closes a menu on Tab without closing its enclosing filter", async () => {
    await wrapper.get('[aria-label="筛选"]').trigger("click");
    await flushPromises();
    await wrapper.get('[aria-label="更多操作"]').trigger("click");
    await flushPromises();
    const first = wrapper.get('[role="menuitem"]').element;
    expect(root.activeElement).toBe(first);
    expect(key(first, "Tab").defaultPrevented).toBe(false);
    await flushPromises();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.find('[role="group"][data-sf-popover]').exists()).toBe(true);
    expect(root.activeElement).toBe(wrapper.get('[aria-label="更多操作"]').element);
  });
});
