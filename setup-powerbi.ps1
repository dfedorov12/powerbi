# ======================================================================
#  Einrichtung "Berichte" (Power BI einbetten)
#
#  Legt in Entra ID alles an, was die App braucht:
#    1. Frontend-Registrierung (SPA, ohne Geheimnis)
#       + eigener API-Bereich  api://<appId>/Berichte.Lesen
#    2. Dienstuser-Registrierung (mit Geheimnis) fuer Power BI
#    3. Sicherheitsgruppe mit dem Dienstuser als Mitglied
#    4. Ausgabe aller Werte fuer js/config.js und die Function App
#
#  Voraussetzung:
#    Install-Module Microsoft.Graph -Scope CurrentUser
#    Connect-MgGraph -Scopes "Application.ReadWrite.All","Group.ReadWrite.All"
#    ./setup-powerbi.ps1
#
#  Was dieses Skript NICHT kann (dafuer gibt es keine API):
#    - die Mandanteneinstellungen im Power-BI-Administrationsportal
#    - den Dienstuser als Mitglied in den Arbeitsbereich eintragen
#    - den Arbeitsbereich einer Kapazitaet zuweisen
#  Diese drei Schritte stehen am Ende als Merkliste.
# ======================================================================

param(
    [string] $Anzeigename    = "Berichte-Frontend",
    # Bestehende Frontend-Registrierung gezielt ansprechen (statt ueber den
    # Anzeigenamen zu suchen). Leer lassen, um eine neue anzulegen.
    [string] $FrontendAppId  = "5813fded-4258-4736-8a7a-6bcc2b76325b",
    [string] $DienstName     = "fabric_report_service_user",
    [string] $GruppenName    = "PowerBI-Einbettung",
    [string[]] $RedirectUris = @(
        "https://dfedorov12.github.io/powerbi/",
        "http://localhost:8774/"
    ),
    [string] $BereichName    = "Berichte.Lesen",
    # Rechteliste AppPermissions nutzen? Dann wird Sites.Read.All ergaenzt -
    # das braucht eine Administratorzustimmung.
    [switch] $MitRechteliste,
    [switch] $KeinGeheimnis
)

$ErrorActionPreference = "Stop"
$g = "https://graph.microsoft.com/v1.0"

# Bekannte Berechtigungs-IDs von Microsoft Graph (delegiert)
$GRAPH_APP_ID   = "00000003-0000-0000-c000-000000000000"
$ID_USER_READ   = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"   # User.Read
$ID_SITES_READ  = "205e70e5-aba6-4c52-a976-6d2d46c48043"   # Sites.Read.All

function Gx {
    param([string]$Method = "GET", [string]$Uri, $Body)
    if ($null -ne $Body) {
        return Invoke-MgGraphRequest -Method $Method -Uri $Uri `
            -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 10)
    }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}

function Find-App([string]$name) {
    $r = Gx -Uri "$g/applications?`$filter=displayName eq '$name'"
    if ($r.value -and $r.value.Count -gt 0) { return $r.value[0] }
    return $null
}

function Ensure-ServicePrincipal([string]$appId) {
    $r = Gx -Uri "$g/servicePrincipals?`$filter=appId eq '$appId'"
    if ($r.value -and $r.value.Count -gt 0) { return $r.value[0] }
    return Gx -Method POST -Uri "$g/servicePrincipals" -Body @{ appId = $appId }
}

Write-Host "=== Berichte (Power BI) - Einrichtung ===" -ForegroundColor Cyan

# ---------------------------------------------------------------------
# 1 - Frontend-Registrierung
# ---------------------------------------------------------------------
Write-Host "`n[1] Frontend-Registrierung '$Anzeigename'" -ForegroundColor Yellow

$benoetigt = @(
    @{ id = $ID_USER_READ; type = "Scope" }
)
if ($MitRechteliste) { $benoetigt += @{ id = $ID_SITES_READ; type = "Scope" } }

$front = $null
if ($FrontendAppId) {
    $r = Gx -Uri "$g/applications?`$filter=appId eq '$FrontendAppId'"
    if ($r.value -and $r.value.Count -gt 0) { $front = $r.value[0] }
}
if (-not $front) { $front = Find-App $Anzeigename }
if ($front) {
    Write-Host "  vorhanden (appId $($front.appId))" -ForegroundColor Green
} else {
    $front = Gx -Method POST -Uri "$g/applications" -Body @{
        displayName    = $Anzeigename
        signInAudience = "AzureADMyOrg"
        spa            = @{ redirectUris = $RedirectUris }
        requiredResourceAccess = @(
            @{ resourceAppId = $GRAPH_APP_ID; resourceAccess = $benoetigt }
        )
    }
    Write-Host "  angelegt (appId $($front.appId))" -ForegroundColor Green
}

# Redirect-URIs ergaenzen, falls die App schon existierte
$vorhandeneUris = @()
if ($front.spa -and $front.spa.redirectUris) { $vorhandeneUris = @($front.spa.redirectUris) }
$fehlende = $RedirectUris | Where-Object { $vorhandeneUris -notcontains $_ }
if ($fehlende) {
    Gx -Method PATCH -Uri "$g/applications/$($front.id)" `
       -Body @{ spa = @{ redirectUris = @($vorhandeneUris + $fehlende) } } | Out-Null
    Write-Host "  Redirect-URIs ergaenzt: $($fehlende -join ', ')" -ForegroundColor Green
}

# API-Bereich anlegen: api://<appId>/Berichte.Lesen
$frontAppId = $front.appId
$scopeId = $null
if ($front.api -and $front.api.oauth2PermissionScopes) {
    $vorhanden = $front.api.oauth2PermissionScopes | Where-Object { $_.value -eq $BereichName }
    if ($vorhanden) { $scopeId = $vorhanden.id }
}

if ($scopeId) {
    Write-Host "  API-Bereich '$BereichName' vorhanden." -ForegroundColor Green
} else {
    $scopeId = [guid]::NewGuid().ToString()
    $bereich = @{
        id    = $scopeId
        value = $BereichName
        type  = "User"       # jede Person darf selbst zustimmen
        isEnabled = $true
        adminConsentDisplayName = "Berichte anzeigen"
        adminConsentDescription = "Erlaubt der Seite, beim Token-Dienst ein Einbettungs-Token fuer freigegebene Power-BI-Berichte anzufordern."
        userConsentDisplayName  = "Berichte anzeigen"
        userConsentDescription  = "Erlaubt der Seite, Ihnen freigegebene Power-BI-Berichte anzuzeigen."
    }

    # ZWEI Schritte noetig: Graph lehnt eine Vorautorisierung ab, deren Bereich
    # es noch nicht kennt ("Permission Id that cannot be found in the
    # AppPermissions sets"). Beim zweiten PATCH muss "api" komplett erneut
    # geschickt werden - ein PATCH ersetzt die ganze Eigenschaft.
    Gx -Method PATCH -Uri "$g/applications/$($front.id)" -Body @{
        identifierUris = @("api://$frontAppId")
        api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @($bereich) }
    } | Out-Null

    Gx -Method PATCH -Uri "$g/applications/$($front.id)" -Body @{
        api = @{
            requestedAccessTokenVersion = 2
            oauth2PermissionScopes = @($bereich)
            # Die Seite darf ihren eigenen Bereich ohne Rueckfrage nutzen.
            preAuthorizedApplications = @(
                @{ appId = $frontAppId; delegatedPermissionIds = @($scopeId) }
            )
        }
    } | Out-Null
    Write-Host "  API-Bereich api://$frontAppId/$BereichName angelegt und vorautorisiert." -ForegroundColor Green
}

Ensure-ServicePrincipal $frontAppId | Out-Null

# ---------------------------------------------------------------------
# 2 - Dienstuser-Registrierung
# ---------------------------------------------------------------------
Write-Host "`n[2] Dienstuser-Registrierung '$DienstName'" -ForegroundColor Yellow
Write-Host "  Hinweis: bewusst OHNE API-Berechtigungen - Power BI erlaubt dem"
Write-Host "  Dienstprinzipal den Zugriff ueber die Mandanteneinstellung und die"
Write-Host "  Mitgliedschaft im Arbeitsbereich, nicht ueber Graph-Berechtigungen."

$dienst = Find-App $DienstName
if ($dienst) {
    Write-Host "  vorhanden (appId $($dienst.appId))" -ForegroundColor Green
} else {
    $dienst = Gx -Method POST -Uri "$g/applications" -Body @{
        displayName    = $DienstName
        signInAudience = "AzureADMyOrg"
    }
    Write-Host "  angelegt (appId $($dienst.appId))" -ForegroundColor Green
}
$dienstSp = Ensure-ServicePrincipal $dienst.appId

$geheimnis = $null
if (-not $KeinGeheimnis) {
    $geheimnis = Gx -Method POST -Uri "$g/applications/$($dienst.id)/addPassword" -Body @{
        passwordCredential = @{ displayName = "Broker $(Get-Date -Format yyyy-MM-dd)" }
    }
    Write-Host "  Neues Geheimnis erzeugt (laeuft ab: $($geheimnis.endDateTime))." -ForegroundColor Green
}

# ---------------------------------------------------------------------
# 3 - Sicherheitsgruppe
# ---------------------------------------------------------------------
Write-Host "`n[3] Sicherheitsgruppe '$GruppenName'" -ForegroundColor Yellow
$grp = (Gx -Uri "$g/groups?`$filter=displayName eq '$GruppenName'").value | Select-Object -First 1
if (-not $grp) {
    $grp = Gx -Method POST -Uri "$g/groups" -Body @{
        displayName     = $GruppenName
        mailEnabled     = $false
        mailNickname    = "powerbi-einbettung"
        securityEnabled = $true
        description     = "Dienstprinzipale, die Power-BI-APIs verwenden duerfen"
    }
    Write-Host "  angelegt (id $($grp.id))" -ForegroundColor Green
} else {
    Write-Host "  vorhanden (id $($grp.id))" -ForegroundColor Green
}

$mitglieder = (Gx -Uri "$g/groups/$($grp.id)/members").value | ForEach-Object { $_.id }
if ($mitglieder -contains $dienstSp.id) {
    Write-Host "  Dienstuser ist bereits Mitglied." -ForegroundColor Green
} else {
    try {
        Gx -Method POST -Uri "$g/groups/$($grp.id)/members/`$ref" `
           -Body @{ "@odata.id" = "$g/directoryObjects/$($dienstSp.id)" } | Out-Null
        Write-Host "  Dienstuser als Mitglied eingetragen." -ForegroundColor Green
    } catch {
        Write-Warning "  Mitgliedschaft fehlgeschlagen: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------
# 4 - Ergebnis
# ---------------------------------------------------------------------
Write-Host "`n===================== WERTE =====================" -ForegroundColor Cyan
Write-Host ""
Write-Host "js/config.js:" -ForegroundColor Yellow
Write-Host "  clientId:  `"$frontAppId`""
Write-Host "  apiScope:  `"api://$frontAppId/$BereichName`""
Write-Host "  brokerUrl: `"https://<name-der-function-app>.azurewebsites.net/api`""
if ($MitRechteliste) {
    Write-Host "  scopes:    [`"User.Read`", `"Sites.Read.All`"]  (Administratorzustimmung noetig)"
}
Write-Host ""
Write-Host "Function App - Umgebungsvariablen:" -ForegroundColor Yellow
Write-Host "  PBI_TENANT_ID       = $((Get-MgContext).TenantId)"
Write-Host "  PBI_CLIENT_ID       = $($dienst.appId)"
if ($geheimnis) {
    Write-Host "  PBI_CLIENT_SECRET   = $($geheimnis.secretText)" -ForegroundColor Magenta
    Write-Host "    ^ wird nie wieder angezeigt - jetzt in die Function App eintragen!" -ForegroundColor Magenta
} else {
    Write-Host "  PBI_CLIENT_SECRET   = <bestehendes Geheimnis>"
}
Write-Host "  FRONTEND_CLIENT_ID  = $frontAppId"
Write-Host "  FRONTEND_SCOPE      = $BereichName"
Write-Host "  ALLOWED_ORIGINS     = https://dfedorov12.github.io"
Write-Host "  PBI_BERICHTE        = [{`"key`":`"bericht1`",`"workspaceId`":`"...`",`"reportId`":`"...`"}]"
Write-Host ""
Write-Host "Sicherheitsgruppe: $GruppenName (id $($grp.id))"
Write-Host ""
Write-Host "=============== NOCH VON HAND ==================" -ForegroundColor Cyan
Write-Host "1. Power-BI-Administrationsportal -> Mandanteneinstellungen -> Entwicklereinstellungen:"
Write-Host "     - 'Dienstprinzipale duerfen Power-BI-APIs verwenden'  -> aktiv fuer '$GruppenName'"
Write-Host "     - 'Inhalte in Apps einbetten'                          -> aktiv"
Write-Host "2. Im Arbeitsbereich: '$DienstName' (oder die Gruppe) als MITGLIED hinzufuegen."
Write-Host "3. Arbeitsbereich einer Kapazitaet zuweisen (F4)."
Write-Host "   ACHTUNG: Liegt das Semantikmodell des Berichts in einem ANDEREN"
Write-Host "   Arbeitsbereich, braucht der Dienstuser auch dort Zugriff -"
Write-Host "   sonst scheitert GenerateToken mit PowerBINotAuthorizedException,"
Write-Host "   obwohl der Bericht selbst lesbar ist."
Write-Host "4. Arbeitsbereich-Id und Bericht-Id in PBI_BERICHTE eintragen."
Write-Host "   (Beide stehen in der Power-BI-Adresse:"
Write-Host "    app.powerbi.com/groups/<workspaceId>/reports/<reportId>/...)"
Write-Host ""
