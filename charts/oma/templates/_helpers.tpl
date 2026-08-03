{{/*
Common name helpers — mirror charts/oma-k8s-bridge/templates/_helpers.tpl,
swapping the prefix to `oma`.
*/}}

{{- define "oma.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "oma.fullname" -}}
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

{{- define "oma.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "oma.labels" -}}
helm.sh/chart: {{ include "oma.chart" . }}
{{ include "oma.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "oma.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oma.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "oma.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "oma.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret that backs main-node's envFrom: secretRef and the
oma-vault sidecar's PLATFORM_ROOT_SECRET secretKeyRef. When the caller brings
their own Secret (secret.existingSecret), every secretRef resolves to that
name; otherwise the chart-managed Secret (templates/secret.yaml) is named
after the release fullname.
*/}}
{{- define "oma.secretName" -}}
{{- default (include "oma.fullname" .) .Values.secret.existingSecret }}
{{- end }}
