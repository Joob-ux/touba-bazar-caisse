// Interface du service d'impression intégré des TPE Q3Pro (IPosPrinterService 5.x).
// L'ordre des méthodes fixe les codes de transaction : relevé sur le TPE, ne pas le changer.
package com.iposprinter.iposprinterservice;

interface IPosPrinterCallback {
    oneway void onRunResult(boolean isSuccess);
    oneway void onReturnString(String result);
}
