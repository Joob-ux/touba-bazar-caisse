package sn.xelkoom.toubabazar;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import com.iposprinter.iposprinterservice.IPosPrinterCallback;
import com.iposprinter.iposprinterservice.IPosPrinterService;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.Set;
import java.util.UUID;

/**
 * Imprimante du TPE pour la caisse web : window.Android.printRaw("base64,<ESC/POS>").
 * 1. Imprimante intégrée du Q3Pro (service IPosPrinterService) : impression directe, sans autre appli.
 * 2. Sinon RawBT s'il est installé.
 * 3. Sinon imprimante Bluetooth appairée (« InnerPrinter », 00:11:22:33:44:55…).
 */
public class PrinterBridge {

    private static final String RAWBT = "ru.a402d.rawbtprinter";
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final Activity activity;
    private volatile IPosPrinterService ipos;

    private final ServiceConnection connexion = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) { ipos = IPosPrinterService.Stub.asInterface(service); }
        @Override public void onServiceDisconnected(ComponentName name) { ipos = null; }
    };

    private final IPosPrinterCallback.Stub retour = new IPosPrinterCallback.Stub() {
        @Override public void onRunResult(boolean ok) { }
        @Override public void onReturnString(String result) { }
    };

    PrinterBridge(Activity activity) {
        this.activity = activity;
        connecterIpos();
    }

    /** Service d'impression intégré des TPE Q3Pro (IPosPrinter). */
    void connecterIpos() {
        try {
            Intent i = new Intent("com.iposprinter.iposprinterservice.IPosPrintService");
            i.setPackage("com.iposprinter.iposprinterservice");
            activity.getApplicationContext().bindService(i, connexion, Context.BIND_AUTO_CREATE);
        } catch (Exception ignored) { }
    }

    void deconnecter() {
        try { activity.getApplicationContext().unbindService(connexion); } catch (Exception ignored) { }
    }

    private static String etatIpos(int s) {
        switch (s) {
            case 0: return null;
            case 1: return "plus de papier";
            case 2: return "tête d'impression trop chaude";
            case 3: return "moteur trop chaud";
            case 4: return null;   // occupée : le ticket est mis en file
            default: return "erreur de l'imprimante (" + s + ")";
        }
    }

    @JavascriptInterface
    public boolean isAvailable() { return true; }

    @JavascriptInterface
    public String printerInfo() {
        if (ipos != null) return "Imprimante intégrée";
        if (rawbtInstalle()) return "RawBT";
        BluetoothDevice d = imprimanteBluetooth();
        return d != null ? "Bluetooth : " + nom(d) : "aucune imprimante trouvée";
    }

    /** data = "base64,...." (commandes ESC/POS préparées par la page). */
    @JavascriptInterface
    public String printRaw(final String data) {
        if (data == null || !data.startsWith("base64,")) return "format invalide";
        final IPosPrinterService p = ipos;
        if (p != null) {
            try {
                String err = etatIpos(p.getPrinterStatus());
                if (err != null) { message("Impression impossible : " + err); return err; }
                byte[] bytes = Base64.decode(data.substring(7), Base64.DEFAULT);
                p.printerInit(retour);
                p.printRawData(bytes, retour);
                p.printerPerformPrint(160, retour);
                return "ok";
            } catch (Exception e) {
                ipos = null;
                connecterIpos();   // le service a peut-être redémarré : on passe aux autres moyens pour ce ticket
            }
        }
        if (rawbtInstalle()) {
            activity.runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("rawbt:" + data));
                    i.setPackage(RAWBT);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(i);
                } catch (Exception e) {
                    imprimerBluetooth(data);
                }
            });
            return "ok";
        }
        imprimerBluetooth(data);
        return "ok";
    }

    /** Export : enregistre le fichier puis ouvre « Partager » (WhatsApp, e-mail, Drive…). */
    @JavascriptInterface
    public void partager(final String nom, final String contenu) {
        activity.runOnUiThread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "export");
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, nom.replaceAll("[^A-Za-z0-9._-]", "_"));
                FileOutputStream out = new FileOutputStream(f);
                out.write(contenu.getBytes(Charset.forName("UTF-8")));
                out.close();
                Uri uri = androidx.core.content.FileProvider.getUriForFile(activity, activity.getPackageName() + ".fichiers", f);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/csv");
                i.putExtra(Intent.EXTRA_STREAM, uri);
                i.putExtra(Intent.EXTRA_SUBJECT, nom);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(Intent.createChooser(i, "Envoyer les ventes"));
            } catch (Exception e) {
                Toast.makeText(activity, "Export impossible : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void imprimerBluetooth(final String data) {
        new Thread(() -> {
            String err = null;
            BluetoothSocket socket = null;
            try {
                BluetoothDevice d = imprimanteBluetooth();
                if (d == null) throw new Exception("imprimante introuvable : installez RawBT depuis le Play Store");
                byte[] bytes = Base64.decode(data.substring(7), Base64.DEFAULT);
                socket = d.createRfcommSocketToServiceRecord(SPP);
                BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
                if (a != null) a.cancelDiscovery();
                socket.connect();
                OutputStream out = socket.getOutputStream();
                for (int i = 0; i < bytes.length; i += 2048) {
                    out.write(bytes, i, Math.min(2048, bytes.length - i));
                    out.flush();
                    Thread.sleep(20);
                }
                Thread.sleep(300);
            } catch (SecurityException e) {
                err = "autorisez le Bluetooth pour la Caisse GestPro (Paramètres > Applis)";
            } catch (Exception e) {
                err = e.getMessage() == null ? e.toString() : e.getMessage();
            } finally {
                try { if (socket != null) socket.close(); } catch (Exception ignored) { }
            }
            if (err != null) {
                final String msg = "Impression impossible : " + err;
                activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void message(final String m) {
        activity.runOnUiThread(() -> Toast.makeText(activity, m, Toast.LENGTH_LONG).show());
    }

    private boolean rawbtInstalle() {
        try {
            activity.getPackageManager().getPackageInfo(RAWBT, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private boolean droitBluetooth() {
        return Build.VERSION.SDK_INT < 31 || activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private String nom(BluetoothDevice d) {
        try { return d.getName() == null ? d.getAddress() : d.getName(); } catch (SecurityException e) { return "?"; }
    }

    /** Imprimante intégrée : nom contenant « inner/printer/pos/mpt » ou adresse virtuelle 00:11:22:33:44:55. */
    private BluetoothDevice imprimanteBluetooth() {
        try {
            if (!droitBluetooth()) return null;
            BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
            if (a == null || !a.isEnabled()) return null;
            Set<BluetoothDevice> appareils = a.getBondedDevices();
            BluetoothDevice candidat = null;
            for (BluetoothDevice d : appareils) {
                String n = nom(d).toLowerCase();
                if ("00:11:22:33:44:55".equals(d.getAddress()) || n.contains("inner")) return d;
                if (candidat == null && (n.contains("printer") || n.contains("pos") || n.contains("mpt") || n.contains("print"))) candidat = d;
            }
            return candidat;
        } catch (SecurityException e) {
            return null;
        }
    }
}
