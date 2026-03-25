$files = @('rules.json', 'rules_1.json', 'rules_2.json', 'rules_3.json', 'rules_4.json', 'rules_5.json', 'rules_6.json', 'rules_7.json', 'rules_8.json', 'rules_9.json')
$totalCount = 0
$allIds = New-Object System.Collections.Generic.HashSet[int]
$duplicateIds = @()
$invalidRules = @()

foreach ($f in $files) {
    if (Test-Path $f) {
        $rules = Get-Content $f -Raw | ConvertFrom-Json
        Write-Host "Auditing $f ($($rules.Count) rules)..."
        $totalCount += $rules.Count
        foreach ($r in $rules) {
            if (-not $allIds.Add($r.id)) {
                $duplicateIds += "Duplicate ID $($r.id) in $f"
            }
            if ($null -eq $r.action -or $null -eq $r.condition) {
                $invalidRules += "Invalid rule structure at ID $($r.id) in $f"
            }
            if ($r.priority -lt 1) {
                $invalidRules += "Invalid priority $($r.priority) at ID $($r.id) in $f"
            }
        }
    }
}

Write-Host "`n--- AUDIT RESULTS ---"
Write-Host "Total Rules: $totalCount"
if ($totalCount -gt 300000) {
    Write-Host "[WARNING] Total rules ($totalCount) exceed global limit (300,000). Some rules may be ignored depending on other extensions."
} elseif ($totalCount -gt 30000) {
    Write-Host "[NOTE] Total rules ($totalCount) exceed guaranteed minimum (30,000) but are within global limit (300,000)."
} else {
    Write-Host "[OK] Total rules ($totalCount) are within the guaranteed minimum (30,000)."
}

if ($duplicateIds.Count -gt 0) {
    Write-Host "[ERROR] Found $($duplicateIds.Count) duplicate IDs!"
    $duplicateIds | Select-Object -First 10 | Write-Host
} else {
    Write-Host "[OK] All rule IDs are unique."
}

if ($invalidRules.Count -gt 0) {
    Write-Host "[ERROR] Found $($invalidRules.Count) invalid rules!"
    $invalidRules | Select-Object -First 10 | Write-Host
} else {
    Write-Host "[OK] All rules have valid structure and priority."
}
