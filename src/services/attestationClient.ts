export type AttestationArtifact = {
  path: string;
  rangeStart?: number;
  rangeEnd?: number;
};

export type AttestationIssueRequest = {
  sub: string;
  repo: string;
  commit: string;
  artifact: AttestationArtifact;
  quiz_id: string;
  quiz_version: string;
  score?: number;
  duration_ms?: number;
  questions_hash?: string;
  answers_hash?: string;
};

export type AttestationIssueResponse = {
  attestation_jwt: string;
  commit: string;
  quiz_id: string;
  exp: number;
};

export async function issueAttestation(
  serverUrl: string,
  request: AttestationIssueRequest
): Promise<AttestationIssueResponse> {
  const url = new URL('/attestations/issue', serverUrl).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Attestation server error (${response.status}): ${body || response.statusText}`
    );
  }

  const data = (await response.json()) as AttestationIssueResponse;
  if (!data.attestation_jwt) {
    throw new Error('Attestation server response missing attestation_jwt.');
  }
  return data;
}
