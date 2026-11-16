# Glance instantiates action callbacks by class name
-keep class * implements androidx.glance.appwidget.action.ActionCallback { <init>(); }
# kotlinx.serialization: keep generated serializers of our models
-keepclassmembers @kotlinx.serialization.Serializable class tools.lars.wgo.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class tools.lars.wgo.**$$serializer { *; }
