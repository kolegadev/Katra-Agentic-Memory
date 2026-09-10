{{/*
Expand the name of the chart.
*/}}
{{- define "katra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "katra.fullname" -}}
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

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "katra.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "katra.labels" -}}
helm.sh/chart: {{ include "katra.chart" . }}
{{ include "katra.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "katra.selectorLabels" -}}
app.kubernetes.io/name: {{ include "katra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "katra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "katra.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build the MongoDB URI from subchart or config
*/}}
{{- define "katra.mongodbUri" -}}
{{- if .Values.secrets.MONGODB_URI }}
{{- .Values.secrets.MONGODB_URI }}
{{- else if .Values.mongodb.enabled }}
{{- $svc := include "katra.fullname" . }}
{{- $database := default "katra" .Values.config.DATABASE_NAME }}
{{- $rootUser := .Values.mongodb.auth.rootUser }}
{{- $rootPassword := .Values.mongodb.auth.rootPassword }}
mongodb://{{ $rootUser }}:{{ $rootPassword }}@{{ .Release.Name }}-mongodb.{{ .Release.Namespace }}.svc.cluster.local:27017/{{ $database }}?authSource=admin
{{- else }}
{{- fail "Either secrets.MONGODB_URI must be set or mongodb.enabled must be true" }}
{{- end }}
{{- end }}

{{/*
Build the Redis URL from subchart or config
*/}}
{{- define "katra.redisUrl" -}}
{{- if .Values.secrets.REDIS_URL }}
{{- .Values.secrets.REDIS_URL }}
{{- else if .Values.redis.enabled }}
{{- if .Values.redis.auth.enabled }}
redis://:{{ .Values.redis.auth.password }}@{{ .Release.Name }}-redis-master.{{ .Release.Namespace }}.svc.cluster.local:6379
{{- else }}
redis://{{ .Release.Name }}-redis-master.{{ .Release.Namespace }}.svc.cluster.local:6379
{{- end }}
{{- else }}
{{- fail "Either secrets.REDIS_URL must be set or redis.enabled must be true" }}
{{- end }}
{{- end }}

{{/*
Build the full list of environment variables for the container
*/}}
{{- define "katra.env" -}}
{{- range $k, $v := $.Values.config }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end }}
