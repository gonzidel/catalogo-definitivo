package com.example.catalogofyl

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.webkit.*
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.example.catalogofyl.ui.theme.CatalogoFYLTheme

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var isNetworkAvailable = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Configurar monitoreo de red
        setupNetworkMonitoring()

        setContent {
            CatalogoFYLTheme {
                AndroidView(
                    factory = { ctx ->
                        createWebView(ctx).also { webView = it }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
    }

    private fun createWebView(context: Context): WebView {
        return WebView(context).apply {
            // Configurar WebViewClient personalizado
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    // Aquí podrías mostrar un loading
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Página cargada completamente
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    if (!isNetworkAvailable) {
                        showToast("Sin conexión: usando caché local")
                    }
                }

                // Interceptar URLs para WhatsApp
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    
                    // Si es WhatsApp, abrir app nativa
                    if (url.startsWith("https://wa.me/")) {
                        try {
                            val intent = Intent(Intent.ACTION_VIEW, request.url)
                            startActivity(intent)
                            return true
                        } catch (e: Exception) {
                            // Si no hay app de WhatsApp, abrir en WebView
                            return false
                        }
                    }
                    
                    return false
                }
            }

            // Configurar WebChromeClient para mejor experiencia
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    super.onProgressChanged(view, newProgress)
                    // Aquí podrías actualizar una barra de progreso
                }
            }

            // Configurar settings
            settings.apply {
                // JavaScript y DOM
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                
                // Cache y rendimiento
                cacheMode = if (isNetworkAvailable) {
                    WebSettings.LOAD_DEFAULT
                } else {
                    WebSettings.LOAD_CACHE_ELSE_NETWORK
                }
                
                // Configuraciones adicionales para mejor rendimiento
                setAppCacheEnabled(true)
                setAppCachePath(context.cacheDir.absolutePath)
                
                // Zoom y viewport
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                
                // Media
                mediaPlaybackRequiresUserGesture = false
                
                // User Agent personalizado
                userAgentString = "$userAgentString FYLApp/1.0"
                
                // Configuraciones de seguridad
                allowFileAccess = false
                allowContentAccess = false
                
                // Configuraciones de rendimiento
                loadsImagesAutomatically = true
                blockNetworkImage = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            }

            // Cargar URL
            loadUrl("https://catalogo-fyl.web.app/")
        }
    }

    private fun setupNetworkMonitoring() {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        
        connectivityManager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                isNetworkAvailable = true
                runOnUiThread {
                    webView.reload()
                    showToast("Conexión restaurada")
                }
            }

            override fun onLost(network: Network) {
                isNetworkAvailable = false
                runOnUiThread {
                    showToast("Sin conexión: usando caché")
                }
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                super.onCapabilitiesChanged(network, networkCapabilities)
                // Aquí podrías detectar si es WiFi o datos móviles
            }
        })
    }

    private fun showToast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    // Manejo del ciclo de vida
    override fun onPause() {
        super.onPause()
        if (this::webView.isInitialized) {
            webView.onPause()
        }
    }

    override fun onResume() {
        super.onResume()
        if (this::webView.isInitialized) {
            webView.onResume()
        }
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }
} 