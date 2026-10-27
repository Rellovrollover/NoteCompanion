// NoteCompanion configuration. The client ID is a public identifier for the Azure app registration.
window.NC_CONFIG = {
  clientId: 'db028f21-7807-45bc-bb83-7a7f7aa9755f',
  authority: 'https://login.microsoftonline.com/common',
  // Redirect back to this app after Microsoft sign-in. Must match the SPA redirect URI in Azure.
  redirectUri: location.origin + location.pathname.replace(/[^/]*$/, ''),
  graphScopes: ['User.Read', 'Files.ReadWrite', 'Notes.Read'],
  // Folder in the root of OneDrive that holds everything.
  driveFolder: 'NoteCompanion',
  // Assets above this size are not downloaded automatically (bytes).
  autoDownloadLimit: 25 * 1024 * 1024,
  version: '0.1.0'
};
