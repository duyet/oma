{{/*
Common name helpers — mirror charts/oma-k8s-bridge/templates/_helpers.tpl,
swapping the prefix to `oma-bridge-daemon`.
*/}}

{{- define "oma-bridge-daemon.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "oma-bridge-daemon.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "oma-bridge-daemon.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "oma-bridge-daemon.labels" -}}
helm.sh/chart: {{ include "oma-bridge-daemon.chart" . }}
{{ include "oma-bridge-daemon.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "oma-bridge-daemon.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oma-bridge-daemon.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "oma-bridge-daemon.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "oma-bridge-daemon.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "oma-bridge-daemon.secretName" -}}
{{- default (include "oma-bridge-daemon.fullname" .) .Values.secret.existingSecret }}
{{- end }}
