// Hardcoded defaults shown in the UI (edit here anytime)
window.STATUS_CONFIG = {
  // Render Docker API — must match the live service URL
  apiUrl: "https://status-hle5.onrender.com",
  passportUser: "ABHISHEKSHPS@GMAIL.COM",
  passportPass: "Mpasspw@01",
  passportFileNo: "LKN067803930926",
  // Set to your Date of Birth in dd/mm/yyyy — enables the public tracker
  // (no-login) which works from cloud IPs.
  passportDob: "",
  gstArn: "AA090726251099S",
  withPassport: false,
};

window.STATUS_API = window.STATUS_CONFIG.apiUrl || "";
