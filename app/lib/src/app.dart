import "package:flutter/material.dart";

class WaterayApp extends StatelessWidget {
  const WaterayApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "wateray",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true),
      home: const Scaffold(
        body: Center(
          child: Text("wateray scaffold ready"),
        ),
      ),
    );
  }
}
