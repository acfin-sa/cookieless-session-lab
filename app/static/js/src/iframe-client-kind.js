export const IFRAME_CLIENT_KIND_EMBED_SDK = "embed_sdk";
export const IFRAME_CLIENT_KIND_RAW_POSTMESSAGE = "raw_postmessage";

export function withIframeClientKind(event, iframeClientKind) {
  return {
    ...event,
    iframe_client_kind: iframeClientKind,
  };
}
