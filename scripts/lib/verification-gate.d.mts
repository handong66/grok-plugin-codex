export declare function gateParagraph(text: string, label: string): string | undefined;
export declare function grokCliVersionLabel(raw: string | undefined): string | undefined;
export declare function formatLiveGateRecord(facts: {
  version: string;
  cliVersion: string | undefined;
  platform: string;
  nodeVersion: string;
  date?: string;
}): string;
export declare function checkVerificationRecords(
  text: string,
  version: string,
  options?: { release?: boolean }
): string[];
