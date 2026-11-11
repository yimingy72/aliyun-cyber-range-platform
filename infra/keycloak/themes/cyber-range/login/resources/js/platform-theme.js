try {
  const savedTheme = localStorage.getItem('range-platform-theme');
  if (savedTheme === 'classic') delete document.documentElement.dataset.platformTheme;
  else if (savedTheme === 'data-dense') document.documentElement.dataset.platformTheme = savedTheme;
} catch {
  // The HTML default also covers browsers that block access to local storage.
}
