// Route Enter through the form's submit handler, including forms whose action
// button is in an Element Plus dialog footer outside the native form element.
export function submitFormOnEnter(event) {
  if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.readOnly || input.disabled) return;
  if (input.getAttribute("role") === "combobox") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  if (input.closest(".el-input-number")) input.blur();
  event.currentTarget.requestSubmit();
}
