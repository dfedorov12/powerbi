# ======================================================================
#  Token-Broker in Azure aufbauen
#
#  Legt Ressourcengruppe, Speicherkonto und Function App an, traegt alle
#  Einstellungen ein und raeumt die Plattform-CORS-Liste leer (der Broker
#  setzt die Kopfzeilen selbst - doppelte lehnt der Browser ab).
#
#  Voraussetzung:
#    - Azure CLI:  winget install Microsoft.AzureCLI
#    - az login
#    - Die Werte aus ../setup-powerbi.ps1 (Frontend- und Dienstuser-Id,
#      Geheimnis des Dienstusers).
#
#  Beispiel:
#    ./setup-broker.ps1 `
#        -DienstClientId "..." `
#        -DienstSecret (Read-Host -AsSecureString "Geheimnis des Dienstusers") `
#        -FrontendClientId "..." `
#        -WorkspaceId "..." -ReportId "..."
#
#  Das Geheimnis wird nur als SecureString entgegengenommen, nie ausgegeben
#  und nirgends in eine Datei geschrieben.
# ======================================================================

param(
    [Parameter(Mandatory = $true)] [string] $DienstClientId,
    [Parameter(Mandatory = $true)] [System.Security.SecureString] $DienstSecret,
    [Parameter(Mandatory = $true)] [string] $FrontendClientId,

    # Erster Bericht. Beide Werte stehen in der Power-BI-Adresse:
    #   app.powerbi.com/groups/<WorkspaceId>/reports/<ReportId>/...
    [string] $WorkspaceId,
    [string] $ReportId,
    [string] $BerichtKey = "bericht1",

    [string] $TenantId       = "fdb70646-023a-403b-a4b9-1f474a935123",
    [string] $Ressourcen     = "rg-berichte-broker",
    # westeurope: dort liegt die F4-Kapazitaet kapdihagdpwesteurope.
    [string] $Ort            = "westeurope",
    # Muss mit APP_NAME in .github/workflows/deploy-broker.yml uebereinstimmen.
    [string] $AppName        = "berichte-token-broker",
    [string] $Speicherkonto  = "",
    [string] $Herkunft       = "https://dfedorov12.github.io",
    [string] $Domaenen       = "dihag.com",
    [string] $AdminUpns      = "administrator@dihag.com,fedorov@dihag.com",
    [string] $Bereich        = "Berichte.Lesen",

    # Veroeffentlichungsprofil direkt als GitHub-Geheimnis hinterlegen
    # (braucht die GitHub CLI und ein angemeldetes gh).
    [switch] $GithubGeheimnis,
    [string] $Repo           = "dfedorov12/powerbi"
)

$ErrorActionPreference = "Stop"

# $Args waere die automatische Variable - daher $Befehl.
function Az {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Befehl)
    $out = & az @Befehl 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($Befehl -join ' ') fehlgeschlagen:`n$out" }
    return $out
}

Write-Host "=== Token-Broker in Azure aufbauen ===" -ForegroundColor Cyan

# ── Vorbedingungen ────────────────────────────────────────────────────
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI nicht gefunden. Installieren mit: winget install Microsoft.AzureCLI"
}
$konto = (Az account show) | ConvertFrom-Json
Write-Host "Abonnement: $($konto.name)  ($($konto.id))"
Write-Host "Angemeldet: $($konto.user.name)"

if (-not $Speicherkonto) {
    # Speicherkontonamen sind weltweit eindeutig: 3-24 Zeichen, klein, alphanumerisch.
    $Speicherkonto = "stberichte" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
}

# ── Ressourcengruppe ──────────────────────────────────────────────────
Write-Host "`n[1] Ressourcengruppe $Ressourcen" -ForegroundColor Yellow
if (([string](Az group exists --name $Ressourcen)).Trim() -eq "true") {
    Write-Host "  vorhanden." -ForegroundColor Green
} else {
    Az group create --name $Ressourcen --location $Ort | Out-Null
    Write-Host "  angelegt in $Ort." -ForegroundColor Green
}

# ── Speicherkonto ─────────────────────────────────────────────────────
Write-Host "`n[2] Speicherkonto $Speicherkonto" -ForegroundColor Yellow
$vorhandene = @(Az storage account list --resource-group $Ressourcen --query "[].name" -o tsv)
if ($vorhandene -contains $Speicherkonto) {
    Write-Host "  vorhanden." -ForegroundColor Green
} else {
    Az storage account create --name $Speicherkonto --resource-group $Ressourcen `
        --location $Ort --sku Standard_LRS --kind StorageV2 `
        --min-tls-version TLS1_2 --allow-blob-public-access false | Out-Null
    Write-Host "  angelegt." -ForegroundColor Green
}

# ── Function App ──────────────────────────────────────────────────────
Write-Host "`n[3] Function App $AppName" -ForegroundColor Yellow
$apps = @(Az functionapp list --resource-group $Ressourcen --query "[].name" -o tsv)
if ($apps -contains $AppName) {
    Write-Host "  vorhanden." -ForegroundColor Green
} else {
    # Flex-Verbrauchsplan: der klassische Linux-Verbrauchsplan laeuft 2028 aus.
    # Node 24, weil 20 seit dem 30.04.2026 EOL ist und Azure es ablehnt.
    Az functionapp create --name $AppName --resource-group $Ressourcen `
        --storage-account $Speicherkonto --flexconsumption-location $Ort `
        --runtime node --runtime-version 24 --https-only true | Out-Null
    Write-Host "  angelegt (Node 24, Flex-Verbrauchsplan)." -ForegroundColor Green
}

Az webapp config set --name $AppName --resource-group $Ressourcen `
    --min-tls-version 1.2 --http20-enabled true | Out-Null

# ── Einstellungen ─────────────────────────────────────────────────────
Write-Host "`n[4] Anwendungseinstellungen" -ForegroundColor Yellow

$klartext = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DienstSecret))

$berichte = "[]"
if ($WorkspaceId -and $ReportId) {
    $berichte = (ConvertTo-Json -Compress -InputObject @(
        @{ key = $BerichtKey; workspaceId = $WorkspaceId; reportId = $ReportId }
    ))
} else {
    Write-Warning "  Ohne -WorkspaceId/-ReportId bleibt PBI_BERICHTE leer."
    Write-Warning "  Nachtragen im Portal oder mit diesem Skript erneut aufrufen."
}

try {
    Az functionapp config appsettings set --name $AppName --resource-group $Ressourcen `
        --settings `
        "PBI_TENANT_ID=$TenantId" `
        "PBI_CLIENT_ID=$DienstClientId" `
        "PBI_CLIENT_SECRET=$klartext" `
        "FRONTEND_CLIENT_ID=$FrontendClientId" `
        "FRONTEND_SCOPE=$Bereich" `
        "PBI_BERICHTE=$berichte" `
        "ALLOWED_ORIGINS=$Herkunft" `
        "ERLAUBTE_DOMAENEN=$Domaenen" `
        "ADMIN_UPNS=$AdminUpns" | Out-Null
    Write-Host "  gesetzt (das Geheimnis wird hier nicht ausgegeben)." -ForegroundColor Green
} finally {
    $klartext = $null
    [System.GC]::Collect()
}

# ── Plattform-CORS setzen ─────────────────────────────────────────────
#  Der Functions-Host beantwortet OPTIONS selbst und laesst die Vorabfrage
#  nicht bis zum Code durch. Ist seine Liste leer, antwortet er 204 ohne
#  Kopfzeilen - der Browser bricht dann ab, bevor die eigentliche Anfrage
#  ueberhaupt gestellt wird. Die Kopfzeilen doppeln sich nicht: die Plattform
#  setzt sie nur auf der Vorabfrage, der Broker nur auf den uebrigen
#  Antworten. Nachgemessen am 04.09.2026.
Write-Host "`n[5] Plattform-CORS setzen" -ForegroundColor Yellow
$herkuenfte = $Herkunft.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$cors = (Az functionapp cors show --name $AppName --resource-group $Ressourcen) | ConvertFrom-Json
$bestehende = @($cors.allowedOrigins)
$fehlend = $herkuenfte | Where-Object { $bestehende -notcontains $_ }
if (-not $fehlend) {
    Write-Host "  bereits vollstaendig: $($bestehende -join ', ')" -ForegroundColor Green
} else {
    Az functionapp cors add --name $AppName --resource-group $Ressourcen `
        --allowed-origins @fehlend | Out-Null
    Write-Host "  ergaenzt: $($fehlend -join ', ')" -ForegroundColor Green
    Write-Host "  Hinweis: die Liste greift erst nach einem Neustart der App."
    Az functionapp restart --name $AppName --resource-group $Ressourcen | Out-Null
    Write-Host "  App neu gestartet." -ForegroundColor Green
}

# ── Veroeffentlichungsprofil ──────────────────────────────────────────
if ($GithubGeheimnis) {
    Write-Host "`n[6] Veroeffentlichungsprofil als GitHub-Geheimnis" -ForegroundColor Yellow
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Warning "  GitHub CLI nicht gefunden - Schritt uebersprungen."
    } else {
        $profil = (Az functionapp deployment list-publishing-profiles `
            --name $AppName --resource-group $Ressourcen --xml) -join "`n"
        $profil | & gh secret set AZURE_FUNCTIONAPP_PUBLISH_PROFILE --repo $Repo
        $profil = $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  hinterlegt in $Repo." -ForegroundColor Green
        } else {
            Write-Warning "  gh secret set fehlgeschlagen."
        }
    }
}

# ── Ergebnis ──────────────────────────────────────────────────────────
$adresse = "https://$AppName.azurewebsites.net"
Write-Host "`n===================== FERTIG ====================" -ForegroundColor Cyan
Write-Host "Broker:      $adresse/api"
Write-Host "Lebenszeichen: $adresse/api/health"
Write-Host ""
Write-Host "js/config.js:" -ForegroundColor Yellow
Write-Host "  brokerUrl: `"$adresse/api`""
Write-Host ""
Write-Host "Naechste Schritte:" -ForegroundColor Yellow
Write-Host "  1. Code veroeffentlichen:"
if ($GithubGeheimnis) {
    Write-Host "     git push  (Workflow deploy-broker.yml laeuft dann automatisch)"
} else {
    Write-Host "     Veroeffentlichungsprofil holen und als Repository-Geheimnis"
    Write-Host "     AZURE_FUNCTIONAPP_PUBLISH_PROFILE hinterlegen - oder dieses"
    Write-Host "     Skript erneut mit -GithubGeheimnis aufrufen."
}
Write-Host "  2. $adresse/api/health aufrufen - dort muss"
Write-Host "     \"eingerichtet\": true stehen."
Write-Host "  3. brokerUrl in js/config.js eintragen und pushen."
Write-Host ""
Write-Host "Kosten: Verbrauchsplan, 1 Mio. Aufrufe im Monat frei. Der Broker wird"
Write-Host "nur beim Oeffnen eines Berichts und einmal je Stunde je offenem"
Write-Host "Dashboard aufgerufen - das bleibt im Freikontingent."
