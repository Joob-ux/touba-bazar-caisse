package sn.xelkoom.toubabazar;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Caisse Touba Bazar pour TPE Android (Q3Pro…), même principe que T.B.T.L :
 * la page est hébergée sur Vercel (BuildConfig.CAISSE_URL), mise en cache pour marcher sans internet.
 * Les ventes restent sur le TPE (localStorage de la WebView), sans serveur ni base de données :
 * désinstaller l'appli ou effacer ses données les supprime.
 * L'imprimante (RawBT / Bluetooth) et le partage de l'export sont donnés à la page via window.Android.
 */
public class MainActivity extends Activity {

    private static final String CAISSE_URL = BuildConfig.CAISSE_URL;
    private static final int CHOIX_FICHIER = 7;
    private WebView webView;
    private ValueCallback<Uri[]> fichierCb;
    private PrinterBridge printer;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // ventes en attente, journal (localStorage)
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " GestProTPE/" + BuildConfig.VERSION_NAME);

        printer = new PrinterBridge(this);
        webView.addJavascriptInterface(printer, "Android");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new WebChromeClient() {
            // Choix du logo de la boutique (champ fichier de la page)
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fichierCb != null) fichierCb.onReceiveValue(null);
                fichierCb = cb;
                try { startActivityForResult(params.createIntent(), CHOIX_FICHIER); }
                catch (ActivityNotFoundException e) { fichierCb = null; return false; }
                return true;
            }
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(CAISSE_URL);
        setContentView(webView);

        demanderBluetooth();
    }

    /** Android 12+ : autorisation Bluetooth pour l'impression directe sur l'imprimante intégrée. */
    private void demanderBluetooth() {
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 1);
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return ouvrir(req.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return ouvrir(Uri.parse(url));
        }

        private boolean ouvrir(Uri uri) {
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            Uri caisse = Uri.parse(CAISSE_URL);
            if (("https".equals(scheme) && caisse.getHost().equals(uri.getHost())) || "about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) return false;
            try {
                Intent i = "intent".equals(scheme) ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, uri);
                startActivity(i);
            } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) {
                String html = "<html><body style='font-family:sans-serif;text-align:center;padding:40px 20px;color:#333'>"
                        + "<h2 style='color:#0f5132'>Pas de connexion</h2>"
                        + "<p>Ouvrez la caisse une première fois avec internet.<br>Ensuite elle marche aussi sans réseau.</p>"
                        + "<button onclick=\"location.href='" + CAISSE_URL + "'\" style='padding:14px 28px;font-size:18px;background:#0f5132;color:#fff;border:0;border-radius:10px'>Réessayer</button>"
                        + "</body></html>";
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) { super.onPageStarted(view, url, favicon); }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == CHOIX_FICHIER && fichierCb != null) {
            fichierCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fichierCb = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (webView != null) webView.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Ferme d'abord un panneau ouvert dans la caisse, sinon met l'appli en arrière-plan
        webView.evaluateJavascript(
                "(function(){var v=[].slice.call(document.querySelectorAll('.voile')).filter(function(x){return !x.hidden});" +
                "if(v.length){v[v.length-1].hidden=true;return 'ferme'}return 'rien'})()",
                r -> { if (r == null || !r.contains("ferme")) moveTaskToBack(true); });
    }

    @Override
    protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }

    @Override
    protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }

    @Override
    protected void onDestroy() {
        if (printer != null) printer.deconnecter();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
