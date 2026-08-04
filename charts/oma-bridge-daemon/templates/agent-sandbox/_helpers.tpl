{{/* agent-sandbox manifest URL — version-derived, overridable via
     agentSandbox.manifestUrl. Used by the pre-install/pre-upgrade hook Job
     (templates/agent-sandbox/hook-job.yaml). */}}
{{- define "oma-bridge-daemon.agentSandbox.manifestUrl" -}}
{{- if .Values.agentSandbox.manifestUrl }}
{{- .Values.agentSandbox.manifestUrl }}
{{- else }}
{{- printf "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/%s/sandbox-with-extensions.yaml" .Values.agentSandbox.version }}
{{- end }}
{{- end }}
