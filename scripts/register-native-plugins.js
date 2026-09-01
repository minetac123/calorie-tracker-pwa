// `npx cap sync ios` staví packageClassList jen z nainstalovaných npm balíčků
// s Capacitor manifestem — naše ručně psané pluginy přímo v Xcode projektu
// (UpdateCheckerPlugin, LiveActivityPlugin, RestAudioPlugin, ...) žádný npm
// balíček nemají, takže je sync nikdy nenajde a seznam v
// ios/App/App/capacitor.config.json zůstane [] navždy — plugin se pak na JS
// straně (Capacitor.Plugins.X) nikdy neobjeví, tiše.
//
// Tenhle skript po syncu doplní chybějící třídy skenem `.m` souborů v
// ios/App/App/ (stejná CAP_PLUGIN(...) makra, co používá Capacitor CLI pro
// npm pluginy), takže se na budoucí nové pluginy nemusí pamatovat ručně.
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', 'ios', 'App', 'App');
const CONFIG_PATH = path.join(APP_DIR, 'capacitor.config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const classList = new Set(config.packageClassList || []);

const capPluginRegex = /CAP_PLUGIN\(([A-Za-z0-9_]+)/;
for (const file of fs.readdirSync(APP_DIR)) {
  if (!file.endsWith('.m')) continue;
  const source = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
  const match = source.match(capPluginRegex);
  if (match) classList.add(match[1]);
}

config.packageClassList = [...classList];
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, '\t') + '\n');
console.log('packageClassList:', config.packageClassList);
