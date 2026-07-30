// Hardcoded defaults shown in the UI (edit here anytime)
window.STATUS_CONFIG = {
  // Render Docker API — must match the live service URL
  apiUrl: "https://status-hle5.onrender.com",
  passportUser: "ABHISHEKSHPS@GMAIL.COM",
  passportPass: "Mpasspw@01",
  passportFileNo: "LKN067803930926",
  gstArn: "AA090726251099S",
  // Passport Seva blocks headless logins from the cloud API;
  // keep this off unless you flip the toggle in the UI.
  withPassport: false,
};

window.STATUS_API = window.STATUS_CONFIG.apiUrl || "";
