import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerUrl, personalSettingsScript, injectPersonalScript, personalWidgetConfig } from '../scripts/build-personal.mjs';

test('accepts public HTTPS and local Navidrome URLs', () => {
    assert.equal(normalizeServerUrl(' https://music.example.com/ '), 'https://music.example.com');
    assert.equal(normalizeServerUrl('http://192.168.1.20:4533/music/'), 'http://192.168.1.20:4533/music');
    assert.equal(normalizeServerUrl('https://music.example.com:443'), 'https://music.example.com');
});
test('rejects unsupported URLs and embedded credentials', () => {
    for (const value of ['music.example.com', 'ftp://host/music', 'https://a:p@music.example.com', 'https://music.example.com/?token=x']) {
        assert.throws(() => normalizeServerUrl(value));
    }
});
test('private script seeds Sonance auth keys and the selected player', () => {
    const code = personalSettingsScript({ serverUrl: 'https://music.example.com', username: 'alice', password: 'long-secret', engine: 'html5' });
    for (const key of ['sonance_server_url', 'sonance_username', 'sonance_password', 'sonance_logged_in', 'sonance_audio_backend']) {
        assert.ok(code.includes(key));
    }
    assert.ok(code.includes('long-secret'));
    assert.ok(!code.includes('console.log'));
});
test('private script does not contain executable HTML tags', () => {
    const code = personalSettingsScript({ serverUrl: 'https://music.example.com', username: '<script>', password: '</script>', engine: 'avplay' });
    assert.ok(!code.includes('<script>') && !code.includes('</script>'));
});
test('injection comes before the core bundle', () => {
    const src = '<script src="js/sonance-core.min.js?v=1"></script>';
    const out = injectPersonalScript(src);
    assert.ok(out.indexOf('sonance-personal-config.js') < out.indexOf('sonance-core.min.js'));
    assert.throws(() => injectPersonalScript('<html/>'));
});
test('separate app ID avoids overwriting the original Sonance', () => {
    const src = '<widget><name>Sonance</name><tizen:application id="S0nance003.Sonance" package="S0nance003"/></widget>';
    const out = personalWidgetConfig(src);
    assert.ok(out.includes('S0Aut0Lg01.SonanceAuto'));
    assert.ok(out.includes('Sonance AutoLogin'));
    assert.ok(!out.includes('S0nance003.Sonance'));
});
