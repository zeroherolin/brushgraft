<script lang="ts">
  import type { Snippet } from "svelte";

  let { label, onclose, children }: { label: string; onclose: () => void; children: Snippet } = $props();
</script>

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="drawer" role="dialog" aria-modal="true" aria-label={label}>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 30;
    animation: fade 0.16s ease-out;
  }

  .drawer {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(340px, 86vw);
    display: flex;
    flex-direction: column;
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 31;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    animation: slide 0.18s ease-out;
  }

  .drawer > :global(nav) {
    flex: 1;
    border-right: 0;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes slide {
    from {
      transform: translateX(-24px);
      opacity: 0;
    }
  }
</style>
