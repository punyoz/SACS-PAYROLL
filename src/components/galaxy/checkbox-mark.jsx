/**
 * Checkbox: dark-gold border with a filled green square when ticked.
 * Shape from Uiverse.io by Shubh0408 ("silly-parrot-64"), MIT license.
 * Recoloured with the theme tokens. Used by src/components/ui/checkbox.jsx.
 */
export const galaxyCheckboxBox =
  "border-gold-text data-[state=checked]:border-gold-text data-[state=checked]:bg-card data-[state=checked]:text-primary dark:data-[state=checked]:bg-input/30";

/** The mark inside a ticked box. */
export function GalaxyCheckMark() {
  return <span className="size-2 rounded-[2px] bg-current" aria-hidden="true" />;
}
