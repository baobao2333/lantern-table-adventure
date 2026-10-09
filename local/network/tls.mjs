import { checkServerIdentity } from "node:tls";
import { certificatePin } from "./invitation.mjs";

export function pinnedTlsOptions({ tlsPin, certificate }) {
  return {
    rejectUnauthorized: true,
    ...(certificate ? { ca: certificate } : {}),
    checkServerIdentity(hostname, peerCertificate) {
      const standardError = checkServerIdentity(hostname, peerCertificate);
      if (standardError) return standardError;
      try {
        if (certificatePin(peerCertificate.raw) !== tlsPin) return new Error("TLS service identity mismatch.");
      } catch { return new Error("Invalid TLS service certificate."); }
      return undefined;
    },
  };
}
